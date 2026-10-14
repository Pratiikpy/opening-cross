// Live proof for the programs added in Wave 3D (ADR-0650 to ADR-0657): cross_mandate, cross_conviction, cross_basket,
// cross_listing, cross_bounty, cross_backing and cross_graduate, with the governed seeding gate in cross_settle. It sends real
// transactions to the cluster named by RPC_URL and reads every outcome back from chain accounts.
//
// Two clusters are supported:
//   - a local validator (RPC_URL=http://127.0.0.1:8899) started by `scripts/w3d-local-validator.sh`, which loads the programs from
//     target/deploy; the funder is airdropped. This is the run that exists today (docs/evidence/W3D-programs-local-validator.md);
//   - devnet, after `scripts/deploy-batch-3.sh` and batch 2, funded from the promiser key.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:w3d            # phase 1: everything that fits in minutes
//   pnpm --filter @opening-cross/devnet-proofs dp:w3d finish     # phase 2, a day or more later: the conviction exits
//
// Some rules cannot be compressed on a live cluster: a conviction lock lasts at least a day, a bounty commits for thirty days, a
// graduation vote runs three days, a listing's release waits a day. Phase 1 proves what is refused while they run (an early unlock,
// an early withdrawal, a round that cannot be finalized, a seeding without an outcome) and phase 2 proves the conviction exits. The
// other exits are proved on LiteSVM with a clock the test sets (tests/core/test/*.test.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Address, type Instruction, type KeyPairSigner, createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getSetAuthorityInstruction, AuthorityType } from '@solana-program/token-2022';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import {
  CrossKind,
  Disclosure,
  FLAG_GOVERNED_GRADUATION,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildSettleBook,
  commitExtras,
  completeRules,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getHaltStateDecoder,
  getInitHaltStateInstruction,
  getInitProtocolInstruction,
  getSetRulesInstruction,
  haltStateAddress,
  orderPda,
  protocolAddress,
  quoteVaultAddress,
  readCrossExt,
  readonly,
  shardAddress,
  shardIndexFor,
  withAccounts,
  writable,
} from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { buildSeedDammV2 } from '@opening-cross/adapters';
import {
  AllowKind,
  findMandatePda,
  findSignerPda,
  getCreateMandateInstruction,
  getFundInstruction as getMandateFundInstruction,
  getMandateDecoder,
  getPlaceOrderInstruction,
  getRevokeInstruction,
  getSweepInstruction,
  getWithdrawInstruction as getMandateWithdrawInstruction,
} from '@opening-cross/cross-mandate-client';
import {
  findBadgeAuthorityPda,
  findBadgeMintPda,
  findLockPda,
  getClaimBadgeInstruction,
  getInitBadgeInstruction,
  getLockDecoder,
  getLockTokensInstruction,
  getUnlockInstruction,
} from '@opening-cross/cross-conviction-client';
import { findBasketPda, findShareMintPda, getCreateBasketInstruction, getMintSharesInstruction, getRedeemSharesInstruction } from '@opening-cross/cross-basket-client';
import {
  findBondPda,
  findListingPda,
  findVenuePda,
  getBondDecoder,
  getCreateVenueInstruction,
  getDepositBondInstruction,
  getListCrossInstruction,
  getListingDecoder,
  getOpenBondInstruction,
  getReleaseListingInstruction,
  getSlashListingInstruction,
} from '@opening-cross/cross-listing-client';
import {
  findBountyPda,
  getAwardInstruction,
  getBountyDecoder,
  getClaimInvariantInstruction,
  getCreateBountyInstruction,
  getFundInstruction as getBountyFundInstruction,
  getWithdrawInstruction as getBountyWithdrawInstruction,
} from '@opening-cross/cross-bounty-client';
import { findAttestationPda, findPolicyPda, findWatchdogPda, getAttestInstruction, getCheckInstruction, getCreatePolicyInstruction } from '@opening-cross/cross-backing-client';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, findCharterPda, findVotePda, getCastVoteInstruction, getFinalizeRoundInstruction, getInitCharterInstruction, getStartRoundInstruction } from '@opening-cross/cross-graduate-client';
import { Evidence, ROOT, RPC, rpc } from './lib.js';
import { accountData, ata, ataIx, balanceOf, chainTime, exists, freshFunder, mintTo, mustFail, newMint, send, sleep, sweepBack, tokenBalance } from './kit.js';

const TP = TOKEN_2022_PROGRAM_ADDRESS;
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const TOKEN = 1_000_000n;
const DAY = 86_400n;
const local = /127\.0\.0\.1|localhost/.test(RPC);
const STATE = `${ROOT}.keys/w3d-proof-state.json`;
const finishing = process.argv[2] === 'finish';
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

const ev = new Evidence(
  local ? 'W3D-programs-local-validator.md' : 'W3D-programs-devnet.md',
  `${local ? 'Local validator' : 'Devnet'} proof: the Wave 3D programs (mandate, conviction, basket, listing, bounty, backing, graduation)`,
  [
    'Script `tests/devnet/src/w3d-proof.ts` (`dp:w3d`). Real transactions; expected refusals are simulated against the loaded programs.',
    `Cluster: ${local ? 'a local validator (solana-test-validator) with the programs loaded from target/deploy by scripts/w3d-local-validator.sh' : 'devnet'}. Throwaway keys.`,
    `Phase ${finishing ? '2 (finish): the conviction exits, a day after the lock' : '1: everything that fits in minutes'}.`,
    '',
    'Not covered: the exits that wait days (listing release, bounty withdrawal, the graduation vote and its outcome), proved on LiteSVM with a set clock; the audit.',
  ],
);

let cleanup: (() => Promise<void>) | undefined;
type State = { funder: number[]; lock?: { mint: string; lockAddress: string } };

/** Records a simulated refusal as a PASS step carrying the program log that names the reason. */
async function refused(id: string, claim: string, ixs: Instruction[], payer: KeyPairSigner, reason: string) {
  ev.record({ id, claim, result: 'PASS', detail: await mustFail(ixs, payer, reason) });
}

async function legacyAta(owner: Address, mint: Address) {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: LEGACY }))[0];
}

async function crossView(address: Address) {
  const data = await accountData(address);
  return { address, data: getCrossDecoder().decode(data), ext: readCrossExt(data) };
}

type Launch = { cross: Address; baseMint: Address };
/** A mint-mode launch: the cross PDA takes the base mint authority; the rules declare the supply a mandate's share is measured against. */
async function launch(issuer: KeyPairSigner, quoteMint: Address, closeInSecs: bigint, governed = false): Promise<Launch> {
  const crossId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const cross = await crossAddress(issuer.address, crossId);
  const baseMint = await newMint(issuer, issuer.address);
  await send([getSetAuthorityInstruction({ owned: baseMint, owner: issuer, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TP }), await ataIx(issuer, issuer.address, baseMint)], issuer);
  const now = await chainTime();
  const built = await buildCreateCross({
    creator: issuer, baseMint, quoteMint, baseTokenProgram: TP, quoteTokenProgram: TP, crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: TOKEN, openTs: now - 5n, closeTs: now + closeInSecs, revealEndTs: now + closeInSecs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: issuer.address, gateMint: null,
    shards: 1, maxOrders: 16, proceedsTo: issuer.address, schedule: [{ price: 1_000_000n, quantity: 1_000n * TOKEN }], settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  });
  const rules = completeRules({ ...(governed ? { flags: FLAG_GOVERNED_GRADUATION } : {}), guards: { totalSupply: 1_000n * TOKEN } });
  await send([built.create, getSetRulesInstruction({ creator: issuer, cross: built.cross, ...rules })], issuer);
  for (const s of built.shards) await send([s], issuer);
  return { cross: built.cross, baseMint };
}

async function waitForClose(closeTs: bigint) {
  while ((await chainTime()) <= closeTs) await sleep(2_000);
}

/** Runs the merge and clear, then claims every named order, then finalizes. */
async function clearAndFinalize(payer: KeyPairSigner, cross: Address, owners: { owner: Address; nonce: bigint }[]) {
  const view = await crossView(cross);
  await waitForClose(view.data.closeTs);
  for (const ix of await buildSettleBook(await crossView(cross), {})) await send([ix], payer);
  for (const o of owners) await send(await buildClaim(await crossView(cross), payer, o.owner, o.nonce), payer);
  await send([await buildFinalize(await crossView(cross), payer)], payer);
}

async function main() {
  const { funder, promiser } = local ? await localFunder() : await devnetFunder();
  cleanup = async () => {
    if (!local) {
      const back = await sweepBack(funder, promiser);
      ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
    }
  };
  if (finishing) return phase2(funder);

  const protocol = await protocolAddress();
  if (!(await exists(protocol))) await send([getInitProtocolInstruction({ admin: funder, protocol, guardian: funder.address, feeRecipient: funder.address, feeBps: [30, 5, 15, 30] })], funder);
  const quoteMint = await newMint(funder, funder.address);
  await mintTo(funder, quoteMint, funder.address, funder, 1_000_000n * TOKEN);

  // ---------------------------------------------------------------- basket (S5)
  {
    const second = await newMint(funder, funder.address);
    await mintTo(funder, second, funder.address, funder, 100_000n * TOKEN);
    const comps = [
      { mint: quoteMint, units: 2n * TOKEN },
      { mint: second, units: 500_000n },
    ];
    const id = BigInt(Date.now());
    const [basket] = await findBasketPda({ creator: funder.address, id });
    const [shareMint] = await findShareMintPda({ basket });
    const vaults = await Promise.all(comps.map((c) => ata(basket, c.mint)));
    const create = withAccounts(getCreateBasketInstruction({ creator: funder, basket, shareMint, id, label: 'Proof basket', unitsPerShare: comps.map((c) => c.units) }), comps.flatMap((c, i) => [readonly(c.mint), readonly(vaults[i]!)]));
    await send([...(await Promise.all(comps.map((c) => ataIx(funder, basket, c.mint)))), create], funder);
    const shareAta = await legacyAta(funder.address, shareMint);
    await send([getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: shareAta, owner: funder.address, mint: shareMint, tokenProgram: LEGACY })], funder);
    const tail = (await Promise.all(comps.map(async (c, i) => [readonly(c.mint), writable(vaults[i]!), writable(await ata(funder.address, c.mint))]))).flat();
    const shares = (n: bigint) => ({ user: funder, basket, shareMint, userShares: shareAta, tokenProgram: LEGACY, token2022Program: TP, shares: n });
    const before = await Promise.all(comps.map((c) => balanceOf(funder.address, c.mint)));
    const sig = await send([withAccounts(getMintSharesInstruction(shares(1_500_000n)), tail)], funder);
    const vaultBalances = await Promise.all(vaults.map(tokenBalance));
    ev.check('basket-mint', '1.5 shares cost 3,000,000 and 750,000 atoms of the two components and the shares arrive', vaultBalances[0] === 3_000_000n && vaultBalances[1] === 750_000n && (await tokenBalance(shareAta)) === 1_500_000n, `vaults ${vaultBalances.join(', ')}, shares ${await tokenBalance(shareAta)}`, sig);
    const sig2 = await send([withAccounts(getRedeemSharesInstruction(shares(1_500_000n)), tail)], funder);
    const after = await Promise.all(comps.map((c) => balanceOf(funder.address, c.mint)));
    ev.check('basket-redeem', 'redeeming all of it returns exactly what was deposited and empties the vaults', after.every((a, i) => a === before[i]) && (await Promise.all(vaults.map(tokenBalance))).every((b) => b === 0n), `balances back to ${after.join(', ')}`, sig2);
    await refused('basket-refusal', 'minting more shares than the user can pay for is refused and moves nothing', [withAccounts(getMintSharesInstruction(shares(10n ** 15n)), tail)], funder, 'insufficient');
  }

  // ---------------------------------------------------------------- a launch for the listing, the bounty and the mandate
  const l = await launch(funder, quoteMint, 90n);
  const protocolAcct = protocol;

  // ---------------------------------------------------------------- listing (L1)
  {
    const venueId = BigInt(Date.now());
    const [venue] = await findVenuePda({ creator: funder.address, id: venueId });
    const slashTo = await generateKeyPairSigner();
    await send([getCreateVenueInstruction({ creator: funder, bondMint: quoteMint, venue, tokenProgram: TP, id: venueId, minBond: 100n * TOKEN, releaseDelaySecs: DAY, slashTo: slashTo.address }), await ataIx(funder, slashTo.address, quoteMint)], funder);
    const [bond] = await findBondPda({ venue, lister: funder.address });
    const vault = await ata(bond, quoteMint);
    await send([getOpenBondInstruction({ lister: funder, venue, bondMint: quoteMint, bond, vault, tokenProgram: TP })], funder);
    await send([getDepositBondInstruction({ lister: funder, venue, bondMint: quoteMint, listerToken: await ata(funder.address, quoteMint), bond, vault, tokenProgram: TP, amount: 250n * TOKEN })], funder);
    const [listing] = await findListingPda({ venue, cross: l.cross });
    const sig = await send([getListCrossInstruction({ lister: funder, venue, bond, cross: l.cross, listing })], funder);
    const b = getBondDecoder().decode(await accountData(bond));
    ev.check('listing-list', 'the creator lists its live cross and 100 of the 250 bond is set aside', b.amount === 250n * TOKEN && b.encumbered === 100n * TOKEN && getListingDecoder().decode(await accountData(listing)).settled === false, `bond ${b.amount}, set aside ${b.encumbered}`, sig);
    await refused('listing-early-release', 'a release before the cross ends and the delay passes is refused', [getReleaseListingInstruction({ listing, lister: funder.address, venue, bond, cross: l.cross })], funder, 'TooEarly');
    await refused('listing-no-fault', 'a slash without a settlement fault is refused', [getSlashListingInstruction({ listing, lister: funder.address, venue, bond, cross: l.cross, bondMint: quoteMint, vault, slashAccount: await ata(slashTo.address, quoteMint), tokenProgram: TP })], funder, 'NoFault');
  }

  // ---------------------------------------------------------------- bounty (X10)
  {
    const arbiter = await generateKeyPairSigner();
    const hunter = await generateKeyPairSigner();
    await send([await ataIx(funder, hunter.address, quoteMint)], funder);
    const bountyId = BigInt(Date.now());
    const [bounty] = await findBountyPda({ sponsor: funder.address, id: bountyId });
    const vault = await ata(bounty, quoteMint);
    const now = await chainTime();
    const sig = await send([getCreateBountyInstruction({ sponsor: funder, rewardMint: quoteMint, bounty, vault, tokenProgram: TP, id: bountyId, arbiter: arbiter.address, expiresAt: now + 31n * DAY, rewards: Array.from({ length: 11 }, () => 10n * TOKEN) })], funder);
    await send([getBountyFundInstruction({ funder, bounty, rewardMint: quoteMint, funderToken: await ata(funder.address, quoteMint), vault, tokenProgram: TP, amount: 200n * TOKEN })], funder);
    ev.check('bounty-create', 'a bounty committing 200 test tokens for 31 days is funded', (await tokenBalance(vault)) === 200n * TOKEN && getBountyDecoder().decode(await accountData(bounty)).expiresAt >= now + 31n * DAY, `pool ${await tokenBalance(vault)}`, sig);
    const claim = async (i: number) => getClaimInvariantInstruction({ claimant: hunter, bounty, rewardMint: quoteMint, cross: l.cross, vault, claimantToken: await ata(hunter.address, quoteMint), tokenProgram: TP, invariant: i });
    for (const i of [0, 4, 7, 10]) await refused(`bounty-honest-${i}`, `invariant ${i} does not fire on the live, honest cross`, [await claim(i)], funder, 'NoViolation');
    const award = await send([getAwardInstruction({ arbiter, bounty, rewardMint: quoteMint, vault, hunterToken: await ata(hunter.address, quoteMint), tokenProgram: TP, amount: 25n * TOKEN, evidence: new Uint8Array(32).fill(1) })], funder);
    ev.check('bounty-award', 'the arbiter awards 25 to a hunter for a report the chain cannot check', (await balanceOf(hunter.address, quoteMint)) === 25n * TOKEN, `hunter holds ${await balanceOf(hunter.address, quoteMint)}`, award);
    await refused('bounty-early-withdraw', 'the sponsor cannot take the pool back during the commitment', [getBountyWithdrawInstruction({ sponsor: funder, bounty, rewardMint: quoteMint, vault, sponsorToken: await ata(funder.address, quoteMint), tokenProgram: TP, amount: 1n })], funder, 'StillCommitted');
  }

  // ---------------------------------------------------------------- mandate (S4, J2), on the live launch
  {
    const agent = await generateKeyPairSigner();
    const id = BigInt(Date.now());
    const [mandate] = await findMandatePda({ owner: funder.address, id });
    const [signer] = await findSignerPda({ mandate });
    const vault = await ata(signer, quoteMint);
    const now = await chainTime();
    await send(
      [
        getCreateMandateInstruction({ owner: funder, agent: agent.address, quoteMint, mandate, signer, vault, tokenProgram: TP, id, limits: { maxPerOrder: 400n * TOKEN, totalCap: 700n * TOKEN, maxShareBps: 2_500, expiresAt: now + DAY, allow: [{ kind: AllowKind.Creator, key: funder.address }] } }),
        getMandateFundInstruction({ owner: funder, mandate, quoteMint, ownerQuote: await ata(funder.address, quoteMint), vault, signer, tokenProgram: TP, amount: 600n * TOKEN, lamports: 20_000_000n }),
      ],
      funder,
    );
    const view = await crossView(l.cross);
    const place = async (price: bigint, quantity: bigint, nonce: bigint) => {
      const [order, orderBump] = await orderPda(l.cross, signer, nonce);
      const ix = getPlaceOrderInstruction({ agent, mandate, signer, quoteMint, vault, protocol: protocolAcct, cross: l.cross, order, shard: await shardAddress(l.cross, shardIndexFor(signer, nonce, view.data.shards)), escrowVault: await quoteVaultAddress(l.cross), tokenProgram: TP, nonce, escrow: costCeil(quantity, price, TOKEN), commitment: new Uint8Array(32), price, quantity, orderBump });
      return withAccounts(ix, await commitExtras(view.ext, l.cross, signer, { class: 0, now: await chainTime(), gateProgram: CROSS_GATE_PROGRAM_ADDRESS }));
    };
    const sig = await send([await place(1_500_000n, 100n * TOKEN, 0n)], funder);
    const m = getMandateDecoder().decode(await accountData(mandate));
    ev.check('mandate-place', 'the agent buys 100 tokens at a limit of 1.5 inside the mandate; 150 leaves the vault and is counted', m.committed === 150n * TOKEN && (await tokenBalance(vault)) === 450n * TOKEN, `committed ${m.committed}, vault ${await tokenBalance(vault)}`, sig);
    await refused('mandate-over-share', 'an order for more than 25% of the declared supply is refused', [await place(1_000_000n, 251n * TOKEN, 1n)], funder, 'OverShareLimit');
    await refused('mandate-over-order', 'an order over the per-order limit is refused', [await place(1_700_000n, 250n * TOKEN, 1n)], funder, 'OverPerOrderLimit');
    const revoke = await send([getRevokeInstruction({ owner: funder, mandate })], funder);
    ev.check('mandate-revoke', 'the owner revokes; a new order is then refused', true, await mustFail([await place(1_500_000n, 10n * TOKEN, 2n)], funder, 'Revoked'), revoke);

    // The cross closes and clears; the order is claimed to the signer PDA; anyone sweeps the base to the owner; the owner withdraws the rest.
    await waitForClose(view.data.closeTs);
    for (const ix of await buildSettleBook(await crossView(l.cross), {})) await send([ix], funder);
    await send(await buildClaim(await crossView(l.cross), funder, signer, 0n), funder);
    ev.check('mandate-fill', 'the cross cleared at 1.0: the signer PDA, not the agent, received 100 tokens and the refund of the unspent escrow', (await balanceOf(signer, l.baseMint)) === 100n * TOKEN && (await tokenBalance(vault)) === 500n * TOKEN, `signer PDA base ${await balanceOf(signer, l.baseMint)}, vault ${await tokenBalance(vault)}`);
    ev.check('mandate-agent-holds-nothing', 'the agent holds none of it', (await balanceOf(agent.address, l.baseMint)) === 0n && (await balanceOf(agent.address, quoteMint)) === 0n, 'agent balances are zero');
    const ownerBase = await ata(funder.address, l.baseMint);
    await send([await ataIx(funder, funder.address, l.baseMint), getSweepInstruction({ mandate, signer, mint: l.baseMint, source: await ata(signer, l.baseMint), destination: ownerBase, tokenProgram: TP })], funder);
    const left = await tokenBalance(vault);
    await send([getMandateWithdrawInstruction({ owner: funder, mandate, quoteMint, vault, ownerQuote: await ata(funder.address, quoteMint), signer, tokenProgram: TP, amount: left })], funder);
    ev.check('mandate-exits', 'the base was swept to the owner and the owner withdrew every quote atom left', (await tokenBalance(ownerBase)) === 100n * TOKEN && (await tokenBalance(vault)) === 0n, `owner base ${await tokenBalance(ownerBase)}, vault ${await tokenBalance(vault)}`);
  }

  // ---------------------------------------------------------------- backing (F6)
  {
    const mint = await newMint(funder, funder.address);
    await mintTo(funder, mint, funder.address, funder, 1_000n * TOKEN);
    const [watchdog] = await findWatchdogPda({ mint });
    const [policy] = await findPolicyPda({ mint });
    const [attestation] = await findAttestationPda({ mint });
    const halt = await haltStateAddress(mint);
    const attester = await generateKeyPairSigner();
    await send([getTransferSolInstruction({ source: funder, destination: attester.address, amount: 20_000_000n })], funder);
    await send([getInitHaltStateInstruction({ authority: funder, baseMint: mint, protocol, halt, venueSigner: watchdog, breaker: null })], funder);
    await send([getCreatePolicyInstruction({ authority: funder, mint, halt, watchdog, policy, attester: attester.address, minCoverageBps: 10_000, maxAgeSecs: 60n })], funder);
    const s1 = await send([getAttestInstruction({ attester, policy, attestation, backingAtoms: 1_000n * TOKEN })], funder);
    const check = () => getCheckInstruction({ policy, mint, attestation, watchdog, halt });
    ev.record({ id: 'backing-backed', claim: 'a fresh statement that covers the live supply is not halted (`Backed`)', result: 'PASS', detail: await mustFail([check()], funder, 'Backed'), signature: s1 });
    await sleep(62_000);
    const sig = await send([check()], funder);
    const h = getHaltStateDecoder().decode(await accountData(halt));
    ev.check('backing-stale', 'once the statement is older than a minute anyone halts the asset', h.halted === true, `halted ${h.halted}`, sig);
  }

  // ---------------------------------------------------------------- conviction (S7), phase 1
  {
    const nonce = BigInt(Date.now());
    const [lock] = await findLockPda({ holder: funder.address, mint: quoteMint, nonce });
    const vault = await ata(lock, quoteMint);
    const unlockTs = (await chainTime()) + DAY + 120n;
    const sig = await send([getLockTokensInstruction({ holder: funder, mint: quoteMint, holderToken: await ata(funder.address, quoteMint), lock, vault, tokenProgram: TP, nonce, amount: 100n * TOKEN, unlockTs })], funder);
    ev.check('conviction-lock', '100 tokens are locked for a day; the vault holds them', (await tokenBalance(vault)) === 100n * TOKEN && getLockDecoder().decode(await accountData(lock)).unlockTs === unlockTs, `vault ${await tokenBalance(vault)}`, sig);
    await refused('conviction-early-unlock', 'an unlock before the time is refused', [getUnlockInstruction({ holder: funder, lock, mint: quoteMint, vault, holderToken: await ata(funder.address, quoteMint), tokenProgram: TP })], funder, 'StillLocked');
    const [badgeMint] = await findBadgeMintPda({ holder: funder.address, mint: quoteMint });
    const [badgeAuthority] = await findBadgeAuthorityPda();
    const initSig = await send([getInitBadgeInstruction({ payer: funder, holder: funder.address, mint: quoteMint, badgeMint, badgeAuthority })], funder);
    const badge = await accountData(badgeMint);
    ev.check('conviction-badge-mint', 'the badge mint is a Token-2022 mint with an extension (the account is longer than a plain mint)', badge.length > 82, `${badge.length} bytes at ${badgeMint}`, initSig);
    writeFileSync(STATE, JSON.stringify({ ...(JSON.parse(readFileSync(STATE, 'utf8')) as State), lock: { mint: quoteMint, lockAddress: lock } } satisfies State));
  }

  // ---------------------------------------------------------------- graduation (D10): a governed cross refuses to seed without an outcome
  {
    const g = await launch(funder, quoteMint, 45n, true);
    const [charter] = await findCharterPda({ cross: g.cross });
    const first = await crossView(g.cross);
    ev.check('graduate-flag', 'a cross created with the governed-graduation rule carries the flag in its rules tail', ((first.ext?.flags ?? 0) & FLAG_GOVERNED_GRADUATION) !== 0, `flags ${first.ext?.flags}`);
    const sig = await send([getInitCharterInstruction({ creator: funder, cross: g.cross, charter, quorumBps: 2_000, windowSecs: 3n * DAY, minVolume: 0n, volumeAttester: null })], funder);
    ev.check('graduate-charter', 'the creator binds the cross to a vote before the first order: quorum 20%, three days', true, `charter ${charter}`, sig);
    await send([await buildPlaceOrder({ cross: first, owner: funder, nonce: 0n, side: OrderSide.Buy, price: 1_300_000n, quantity: 100n * TOKEN, now: await chainTime() })], funder);
    await clearAndFinalize(funder, g.cross, [{ owner: funder.address, nonce: 0n }]);
    const done = await crossView(g.cross);
    const seed = await buildSeedDammV2({ cross: done, creator: funder, baseAmount: 10n * TOKEN, quoteAmount: 13n * TOKEN, feeBps: 30 });
    await refused('graduate-gate', 'the creator cannot open a DAMM v2 pool for the governed cross without a passed vote', [cu, seed.instruction], funder, 'GraduationNotApproved');
    const [roundAddress] = await getProgramDerivedAddress({ programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('round'), getAddressEncoder().encode(g.cross), new Uint8Array([0])] });
    await send([getStartRoundInstruction({ creator: funder, cross: g.cross, charter, baseMint: g.baseMint, round: roundAddress, escrow: await ata(roundAddress, g.baseMint), tokenProgram: TP })], funder);
    const [vote] = await findVotePda({ round: roundAddress, voter: funder.address });
    const voted = await send([getCastVoteInstruction({ voter: funder, round: roundAddress, baseMint: g.baseMint, voterToken: await ata(funder.address, g.baseMint), escrow: await ata(roundAddress, g.baseMint), vote, tokenProgram: TP, venue: 0, amount: 100n * TOKEN })], funder);
    ev.check('graduate-vote', 'a round opens after the cross is finalized and the holder locks 100 tokens behind DAMM v2', (await tokenBalance(await ata(roundAddress, g.baseMint))) === 100n * TOKEN, `escrow ${await tokenBalance(await ata(roundAddress, g.baseMint))}`, voted);
    await refused('graduate-window', 'the round cannot be finalized while the three-day window is open', [getFinalizeRoundInstruction({ round: roundAddress, charter, baseMint: g.baseMint })], funder, 'WindowOpen');
    await refused('graduate-still-gated', 'the gate still holds while the vote runs', [cu, seed.instruction], funder, 'GraduationNotApproved');
  }
}

async function phase2(funder: KeyPairSigner) {
  const st = JSON.parse(readFileSync(STATE, 'utf8')) as State;
  if (!st.lock) throw new Error('no lock saved: run phase 1 first');
  const mint = st.lock.mint as Address;
  const lock = st.lock.lockAddress as Address;
  const [badgeMint] = await findBadgeMintPda({ holder: funder.address, mint });
  const [badgeAuthority] = await findBadgeAuthorityPda();
  const vault = await ata(lock, mint);
  const holderBadge = await ata(funder.address, badgeMint);
  const before = await balanceOf(funder.address, mint);
  const sig = await send(
    [
      getUnlockInstruction({ holder: funder, lock, mint, vault, holderToken: await ata(funder.address, mint), tokenProgram: TP }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: holderBadge, owner: funder.address, mint: badgeMint, tokenProgram: TP }),
      getClaimBadgeInstruction({ holder: funder, lock, mint, badgeMint, badgeAuthority, holderBadge }),
    ],
    funder,
  );
  ev.check('conviction-exit', 'after the day the tokens come back and the badge is minted (100 tokens for a day and a bit: at least 100 token-days)', (await balanceOf(funder.address, mint)) === before + 100n * TOKEN && (await tokenBalance(holderBadge)) >= 100n, `badge ${await tokenBalance(holderBadge)}`, sig);
}

/** A fresh throwaway keypair, kept in the git-ignored key folder so the second phase can sign again. */
async function newFunderKey(): Promise<KeyPairSigner> {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...raw]);
  writeFileSync(STATE, JSON.stringify({ funder: [...bytes] } satisfies State));
  return createKeyPairSignerFromBytes(bytes);
}

/** On devnet the first phase draws a throwaway funder from the promiser key (kept by `freshFunder` in `.keys`); the second signs again with it. */
async function devnetFunder(): Promise<{ funder: KeyPairSigner; promiser: KeyPairSigner }> {
  const promiser = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/devnet-promiser.json`, 'utf8'))));
  if (finishing) {
    const funder = await createKeyPairSignerFromBytes(Uint8Array.from((JSON.parse(readFileSync(STATE, 'utf8')) as State).funder));
    return { funder, promiser };
  }
  const made = await freshFunder(1_200_000_000n);
  const saved = JSON.parse(readFileSync(`${ROOT}.keys/devnet-proof-funder-${made.funder.address.slice(0, 6)}.json`, 'utf8')) as number[];
  writeFileSync(STATE, JSON.stringify({ funder: saved } satisfies State));
  return made;
}

/** On a local validator the funder is airdropped; there is no promiser to return anything to. */
async function localFunder(): Promise<{ funder: KeyPairSigner; promiser: KeyPairSigner }> {
  if (finishing && existsSync(STATE)) {
    const funder = await createKeyPairSignerFromBytes(Uint8Array.from((JSON.parse(readFileSync(STATE, 'utf8')) as State).funder));
    return { funder, promiser: funder };
  }
  const funder = await newFunderKey();
  await rpc.requestAirdrop(funder.address, 100_000_000_000n as never, { commitment: 'confirmed' }).send();
  for (let i = 0; i < 60 && (await rpc.getBalance(funder.address, { commitment: 'confirmed' }).send()).value === 0n; i++) await sleep(500);
  return { funder, promiser: funder };
}

main()
  .then(async () => {
    await cleanup?.();
    ev.write();
  })
  .catch(async (e) => {
    await cleanup?.().catch(() => undefined);
    ev.write(e);
  });
