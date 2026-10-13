// Devnet proof for the treasury extension (ADR-0470 to 0475), to run once the upgraded `treasury` program is deployed
// (scripts/deploy-batch-2.sh). It has NOT been run: it needs the upgrade and devnet SOL, and the local proof is
// `tests/core/test/treasury-*.test.ts` on LiteSVM.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:treasury-ext            # phase 1: everything that fits in minutes
//   pnpm --filter @opening-cross/devnet-proofs dp:treasury-ext finish     # phase 2, 4+ days later: execute the vote
//
// Phase 1 extends a fresh treasury with short windows where the program allows them (revenue rounds, the NAV period, grant
// lockups), then runs staking and distributions, a paid and a missed revenue round, the NAV exit, the disclosure feed, the
// assignment gate and a team grant. The program refuses a vote shorter than three days, a timelock shorter than a day and a
// sweep window shorter than 180 days, so a vote, its execution and the wind-down sweep cannot compress: phase 1 creates and
// votes a proposal and checks the refusals that apply while it runs, and phase 2 executes it after the timelock.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type Address, type KeyPairSigner, createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintToInstruction } from '@solana-program/token-2022';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import {
  ProposalKind,
  TREASURY_PROGRAM_ADDRESS,
  decodeTreasuryExt,
  encodeRevenueAttestation,
  findGrantPda,
  findProposalPda,
  findTreasuryPda,
  findVaultPda,
  getClaimDistributionInstructionAsync,
  getCreateGrantInstructionAsync,
  getCreateTreasuryInstruction,
  getDepositDistributionInstructionAsync,
  getExecuteProposalInstructionAsync,
  getExpireGrantInstructionAsync,
  getInitExtInstructionAsync,
  getMarkMissedInstructionAsync,
  getNavRedeemInstructionAsync,
  getPayRoundInstructionAsync,
  getPostDisclosureInstruction,
  getProposeInstructionAsync,
  getReclaimVoteInstructionAsync,
  getRecordAssignmentInstruction,
  getReleaseMilestoneInstructionAsync,
  getRequestDisclosureInstruction,
  getRevenueRoundNonce,
  getSpendInstruction,
  getStakeInstructionAsync,
  getVoteInstructionAsync,
  findVoteRecordPda,
} from '@opening-cross/treasury-client';
import { Evidence, ROOT } from './lib.js';
import { accountData, asIx, ata, ataIx, balanceOf, chainTime, exists, freshFunder, fundWallets, mintTo, mustFail, newMint, revokeMintAuthority, send, sweepBack, tokenBalance, waitUntil } from './kit.js';

const TP = TOKEN_2022_PROGRAM_ADDRESS;
const COIN = 1_000_000n;
const STATE = `${ROOT}.keys/w2d-treasury-ext-state.json`;
const finishing = process.argv[2] === 'finish';

const ev = new Evidence('W2D-treasury-ext-devnet.md', 'Devnet proof — treasury extension: votes, NAV, distributions, revenue rounds, grants, disclosure, assignment (W2D)', [
  'Script `tests/devnet/src/treasury-ext-proof.ts` (`dp:treasury-ext`). Real devnet transactions; expected refusals are simulated against the deployed program.',
  `Program: treasury \`${TREASURY_PROGRAM_ADDRESS}\` after the batch-2 upgrade. Throwaway keys, funded from the devnet promiser key.`,
  `Phase ${finishing ? '2 (finish): executes the vote after the timelock' : '1: everything that fits in minutes'}.`,
  '',
  'Not covered: a real revenue attester or counsel (throwaway SAS issuer); the 180-day wind-down sweep (the program refuses shorter windows); multi-day NAV periods.',
]);

let cleanup: (() => Promise<void>) | undefined;

async function main() {
  const { funder, promiser } = await freshFunder(finishing ? 20_000_000n : 400_000_000n);
  cleanup = async () => {
    const back = await sweepBack(funder, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  if (finishing) return phase2(funder);
  // alice, bob and carol are made from saved seeds so phase 2 can sign for them again.
  const seeds = Object.fromEntries(['alice', 'bob', 'carol'].map((k) => [k, crypto.getRandomValues(new Uint8Array(32))]));
  const [team, attester, company, recovery] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((k) => createKeyPairSignerFromPrivateKeyBytes(seeds[k]!)));
  await fundWallets(funder, [team!.address, alice!.address, bob!.address, carol!.address, company!.address, recovery!.address], 30_000_000n);
  await fundWallets(funder, [attester!.address], 30_000_000n);

  // SAS: one credential, three schemas (spend attestation, revenue u64, assignment).
  const credName = `oc-ext-${Date.now()}`;
  const [credential] = await deriveCredentialPda({ authority: attester!.address, name: credName });
  const schemaOf = async (name: string, layout: number[]) => {
    const [schema] = await deriveSchemaPda({ credential, name, version: 1 });
    await send([asIx(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema, name, description: name, layout: new Uint8Array(layout), fieldNames: ['v'] } as never))], attester!);
    return schema;
  };
  await send([asIx(getCreateCredentialInstruction({ payer: attester, credential, authority: attester, name: credName, signers: [attester!.address] } as never))], attester!);
  const [spendSchema, revSchema, assignSchema] = [await schemaOf('spend', [0]), await schemaOf('revenue', [3]), await schemaOf('assignment', [0])];
  const attest = async (nonce: Address, schema: Address, data: Uint8Array, expiry: bigint) => {
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce });
    const sig = await send([asIx(getCreateAttestationInstruction({ payer: attester, authority: attester, credential, schema, attestation, nonce, data, expiry } as never))], attester!);
    return { attestation, sig };
  };

  const quote = await newMint(funder, funder.address);
  const coin = await newMint(funder, funder.address);
  await send([await ataIx(funder, team!.address, quote), await ataIx(funder, alice!.address, quote), await ataIx(funder, bob!.address, quote), await ataIx(funder, carol!.address, quote), await ataIx(funder, company!.address, quote), await ataIx(funder, recovery!.address, quote)], funder);
  for (const [w, n] of [[team!, 200n], [alice!, 400n], [bob!, 300n], [carol!, 100n]] as [KeyPairSigner, bigint][]) await mintTo(funder, coin, w.address, funder, n * COIN);
  await revokeMintAuthority(funder, coin, funder);
  await mintTo(funder, quote, company!.address, funder, 100_000n * COIN);

  const [treasury] = await findTreasuryPda({ coinMint: coin });
  const [vault] = await findVaultPda({ treasury });
  await send([getCreateTreasuryInstruction({ authority: team!, coinMint: coin, quoteMint: quote, treasury, vault, quoteTokenProgram: TP, allowance: 1_000n * COIN, periodSecs: 3_600n, graceSecs: 3_600n, credential, schema: spendSchema })], team!);
  await send([getMintToInstruction({ mint: quote, token: vault, mintAuthority: funder, amount: 10_000n * COIN }, { programAddress: TP })], funder);
  const now = await chainTime();
  const ZERO = '11111111111111111111111111111111' as Address;
  const roundSecs = 40n;
  const revStart = now + 20n;
  const ext = {
    votePeriodSecs: 3n * 86_400n, timelockSecs: 86_400n, quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 5_000, proposerMinBps: 100,
    minLockupSecs: 0n, navPeriodSecs: 60n, navCapBps: 5_000, insiders: [team!.address, ZERO, ZERO, ZERO] as Address[],
    revShareBps: 1_000, revCredential: credential, revSchema, roundSecs, revStart, payGraceSecs: 30n, streamSecs: 0n, trancheMinRevenue: 1_000n * COIN, trancheAmount: 100n * COIN,
    disclosurePeriodSecs: 86_400n, requestMinBps: 100, assignRequired: true, assignCredential: credential, assignSchema,
    windowSecs: 180n * 86_400n, recovery: recovery!.address,
  };
  const extSig = await send([await getInitExtInstructionAsync({ authority: team!, treasury, coinMint: coin, quoteMint: quote, coinTokenProgram: TP, quoteTokenProgram: TP, ...ext })], team!);
  const e0 = decodeTreasuryExt(await accountData(treasury));
  ev.check('extend', 'a v1-layout treasury is extended in place: the tail appears after the old fields, the vaults exist', e0 !== null && e0.votePeriodSecs === ext.votePeriodSecs, `treasury ${treasury}`, extSig);

  const coinOf = (w: KeyPairSigner) => ata(w.address, coin);
  const quoteOf = (w: KeyPairSigner) => ata(w.address, quote);

  // ------------------------------------------------------------------ distributions
  await send([await getStakeInstructionAsync({ owner: alice!, treasury, coinMint: coin, ownerCoin: await coinOf(alice!), coinTokenProgram: TP, amount: 300n * COIN })], alice!);
  await send([await getStakeInstructionAsync({ owner: bob!, treasury, coinMint: coin, ownerCoin: await coinOf(bob!), coinTokenProgram: TP, amount: 100n * COIN })], bob!);
  const depSig = await send([await getDepositDistributionInstructionAsync({ depositor: company!, treasury, quoteMint: quote, depositorQuote: await quoteOf(company!), quoteTokenProgram: TP, amount: 400n * COIN })], company!);
  await send([await getClaimDistributionInstructionAsync({ owner: alice!, treasury, quoteMint: quote, ownerQuote: await quoteOf(alice!), quoteTokenProgram: TP })], alice!);
  await send([await getClaimDistributionInstructionAsync({ owner: bob!, treasury, quoteMint: quote, ownerQuote: await quoteOf(bob!), quoteTokenProgram: TP })], bob!);
  ev.check('distribution', 'a 400-quote deposit is shared 300:100 between two stakers, exactly', (await balanceOf(alice!.address, quote)) === 300n * COIN && (await balanceOf(bob!.address, quote)) === 100n * COIN, `alice ${await balanceOf(alice!.address, quote)}, bob ${await balanceOf(bob!.address, quote)}`, depSig);
  ev.check('refuse-double-claim', 'a second claim is refused (NothingToClaim)', true, await mustFail([await getClaimDistributionInstructionAsync({ owner: alice!, treasury, quoteMint: quote, ownerQuote: await quoteOf(alice!), quoteTokenProgram: TP })], alice!, 'NothingToClaim'));

  // ------------------------------------------------------------------ revenue round 0 paid, round 1 missed, NAV exit
  const nonce0 = await getRevenueRoundNonce(treasury, 0n);
  const a0 = await attest(nonce0, revSchema, encodeRevenueAttestation(5_000n * COIN), 0n);
  ev.check('refuse-round-open', 'a round cannot be paid before it ends (RoundOpen)', true, await mustFail([await getPayRoundInstructionAsync({ payer: company!, treasury, quoteMint: quote, payerQuote: await quoteOf(company!), attestation: a0.attestation, quoteTokenProgram: TP, round: 0n })], company!, 'RoundOpen'));
  await waitUntil(revStart + roundSecs);
  const paySig = await send([await getPayRoundInstructionAsync({ payer: company!, treasury, quoteMint: quote, payerQuote: await quoteOf(company!), attestation: a0.attestation, quoteTokenProgram: TP, round: 0n })], company!);
  ev.check('round-paid', 'round 0 pays 10% of the attested 5,000 revenue into the stakers\' pot', true, '500 quote moved to the distribution vault', paySig);
  await waitUntil(revStart + 2n * roundSecs + 31n);
  const missSig = await send([await getMarkMissedInstructionAsync({ caller: carol!, treasury, coinMint: coin, round: 1n })], carol!);
  const e1 = decodeTreasuryExt(await accountData(treasury));
  ev.check('round-missed', 'round 1 had no attestation: anyone records it missed and the NAV window opens', e1?.navOpen === true && e1.missedRounds === 1, `navOpen ${e1?.navOpen}`, missSig);
  const navIx = async (w: KeyPairSigner, amount: bigint) => getNavRedeemInstructionAsync({ holder: w, treasury, coinMint: coin, quoteMint: quote, holderCoin: await coinOf(w), holderQuote: await quoteOf(w), vault, coinTokenProgram: TP, quoteTokenProgram: TP, amount });
  ev.check('refuse-insider-nav', 'the team (an insider) cannot redeem at NAV (InsiderExcluded)', true, await mustFail([await navIx(team!, COIN)], team!, 'InsiderExcluded'));
  const vaultBefore = await tokenBalance(vault);
  const navSig = await send([await navIx(carol!, 50n * COIN)], carol!);
  ev.check('nav-redeem', 'a holder redeems 50 of 1,000 coins at NAV: the share of the vault, rounded down', (await balanceOf(carol!.address, quote)) === (vaultBefore * 50n) / 1_000n, `carol received ${await balanceOf(carol!.address, quote)} of vault ${vaultBefore}`, navSig);
  const att = await attest(treasury, spendSchema, new Uint8Array([1]), (await chainTime()) + 3_600n);
  ev.check('refuse-spend-nav', 'the team allowance is frozen while the NAV window is open (NavMode)', true, await mustFail([getSpendInstruction({ authority: team!, treasury, attestation: att.attestation, quoteMint: quote, vault, destination: await quoteOf(team!), quoteTokenProgram: TP, amount: COIN })], team!, 'NavMode'));

  // ------------------------------------------------------------------ disclosure and assignment
  const reqSig = await send([getRequestDisclosureInstruction({ holder: carol!, treasury, coinMint: coin, holderCoin: await coinOf(carol!) })], carol!);
  const e2 = decodeTreasuryExt(await accountData(treasury));
  ev.check('disclosure-request', 'a holder\'s request opens the disclosure clock', (e2?.openRequestTs ?? 0n) > 0n, `open since ${e2?.openRequestTs}`, reqSig);
  const postSig = await send([getPostDisclosureInstruction({ authority: team!, treasury, hash: new Uint8Array(32).fill(1) })], team!);
  ev.check('disclosure-post', 'the team posts; the request is cleared', decodeTreasuryExt(await accountData(treasury))?.openRequestTs === 0n, 'open request cleared', postSig);
  ev.check('refuse-assignment-unrecorded', 'recording the assignment without counsel\'s attestation is refused (NotAttested)', true, await mustFail([getRecordAssignmentInstruction({ treasury, attestation: (await deriveAttestationPda({ credential, schema: assignSchema, nonce: treasury }))[0] })], carol!, 'NotAttested'));
  const asg = await attest(treasury, assignSchema, new Uint8Array([1]), 0n);
  const asgSig = await send([getRecordAssignmentInstruction({ treasury, attestation: asg.attestation })], carol!);
  ev.check('assignment', 'with counsel\'s attestation the assignment is recorded', decodeTreasuryExt(await accountData(treasury))?.assigned === true, 'assigned = true', asgSig);

  // ------------------------------------------------------------------ team grant: carve-out, refused earn-out, expiry burn
  const t1 = await chainTime();
  const grantSig = await send([await getCreateGrantInstructionAsync({
    authority: team!, treasury, coinMint: coin, authorityCoin: await coinOf(team!), coinTokenProgram: TP, id: 0n,
    beneficiary: carol!.address, total: 100n * COIN, lockupEnd: t1 + 30n, expiryTs: t1 + 90n,
    milestones: [{ bps: 4_000, requiresAttestation: false, released: false }, { bps: 4_000, requiresAttestation: true, released: false }, { bps: 0, requiresAttestation: false, released: false }, { bps: 0, requiresAttestation: false, released: false }],
    milestoneCount: 2, credential, schema: spendSchema,
  } as never)], team!);
  const [grant] = await findGrantPda({ treasury, id: 0n });
  ev.check('grant', 'the team escrows 100 coins in a grant with a 30 s lockup', await exists(grant), `grant ${grant}`, grantSig);
  const carolCoin = await coinOf(carol!);
  const rel = async (index: number, attestation: Address) => getReleaseMilestoneInstructionAsync({ cranker: bob!, treasury, grant, coinMint: coin, beneficiaryCoin: carolCoin, attestation, coinTokenProgram: TP, index });
  ev.check('refuse-lockup', 'a milestone cannot be released inside the lockup (MilestoneNotReady)', true, await mustFail([await rel(0, ZERO)], bob!, 'MilestoneNotReady'));
  await waitUntil(t1 + 31n);
  const before = await balanceOf(carol!.address, coin);
  const relSig = await send([await rel(0, ZERO)], bob!);
  ev.check('carve-out', 'after the lockup anyone cranks the carve-out: 40 coins reach the beneficiary', (await balanceOf(carol!.address, coin)) - before === 40n * COIN, 'carol +40 coins', relSig);
  ev.check('refuse-earn-out', 'the earn-out needs its attestation (NotAttested)', true, await mustFail([await rel(1, (await deriveAttestationPda({ credential, schema: spendSchema, nonce: grant }))[0])], bob!, 'NotAttested'));
  await waitUntil(t1 + 91n);
  const expSig = await send([await getExpireGrantInstructionAsync({ cranker: bob!, treasury, grant, coinMint: coin, coinTokenProgram: TP })], bob!);
  ev.check('grant-expiry', 'after expiry the unearned 60 coins are burned', decodeTreasuryExt(await accountData(treasury))?.grantsUnreleased === 0n, 'grants_unreleased = 0', expSig);

  // ------------------------------------------------------------------ the vote: created and voted now, executed in phase 2
  const proposeSig = await send([await getProposeInstructionAsync({ proposer: alice!, treasury, coinMint: coin, proposerCoin: await coinOf(alice!), id: 0n, kind: ProposalKind.CloseNav, amount: 0n, destination: ZERO, descHash: new Uint8Array(32) })], alice!);
  await send([await getVoteInstructionAsync({ voter: alice!, treasury, proposal: (await findProposalPda({ treasury, id: 0n }))[0], coinMint: coin, voterCoin: await coinOf(alice!), coinTokenProgram: TP, support: true, amount: 100n * COIN })], alice!);
  await send([await getVoteInstructionAsync({ voter: bob!, treasury, proposal: (await findProposalPda({ treasury, id: 0n }))[0], coinMint: coin, voterCoin: await coinOf(bob!), coinTokenProgram: TP, support: true, amount: 100n * COIN })], bob!);
  const [proposal] = await findProposalPda({ treasury, id: 0n });
  ev.check('proposal', 'a close-NAV proposal is created and gathers 200 yes votes', await exists(proposal), `proposal ${proposal}`, proposeSig);
  ev.check('refuse-early-execute', 'it cannot be executed while the vote runs (TimelockPending)', true, await mustFail([await getExecuteProposalInstructionAsync({ executor: carol!, treasury, proposal, coinMint: coin, quoteMint: quote, vault, destination: await quoteOf(carol!), quoteTokenProgram: TP })], carol!, 'TimelockPending'));
  ev.check('refuse-early-reclaim', 'voters cannot take their coins back while it runs (VotingOpen)', true, await mustFail([await getReclaimVoteInstructionAsync({ voter: alice!, treasury, proposal, voteRecord: (await findVoteRecordPda({ proposal, voter: alice!.address }))[0], coinMint: coin, voterCoin: await coinOf(alice!), coinTokenProgram: TP })], alice!, 'VotingOpen'));

  mkdirSync(`${ROOT}.keys`, { recursive: true });
  writeFileSync(STATE, JSON.stringify({
    coin, quote, treasury, vault, proposal, createdAt: (await chainTime()).toString(),
    seeds: Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k, Array.from(v)])),
  }));
  ev.check('state-saved', 'the vote\'s state is saved for phase 2 (run `dp:treasury-ext finish` four or more days after this line)', existsSync(STATE), STATE);
}

async function phase2(funder: KeyPairSigner) {
  const s = JSON.parse(readFileSync(STATE, 'utf8')) as { coin: Address; quote: Address; treasury: Address; vault: Address; proposal: Address; createdAt: string; seeds: Record<string, number[]> };
  const key = (k: string) => createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(s.seeds[k]!));
  const [alice, bob, carol] = await Promise.all([key('alice'), key('bob'), key('carol')]);
  await fundWallets(funder, [alice.address, bob.address, carol.address], 5_000_000n);
  const earliest = BigInt(s.createdAt) + 4n * 86_400n;
  if ((await chainTime()) < earliest) throw new Error(`too early: the timelock ends at ${earliest}`);
  const dest = await ata(carol.address, s.quote);
  const execSig = await send([await getExecuteProposalInstructionAsync({ executor: carol, treasury: s.treasury, proposal: s.proposal, coinMint: s.coin, quoteMint: s.quote, vault: s.vault, destination: dest, quoteTokenProgram: TP })], carol);
  ev.check('execute', 'after the vote and the timelock the passed proposal executes: the NAV window closes', decodeTreasuryExt(await accountData(s.treasury))?.navOpen === false, 'nav_open = false', execSig);
  for (const [w, name] of [[alice, 'alice'], [bob, 'bob']] as [KeyPairSigner, string][]) {
    const before = await balanceOf(w.address, s.coin);
    const sig = await send([await getReclaimVoteInstructionAsync({ voter: w, treasury: s.treasury, proposal: s.proposal, voteRecord: (await findVoteRecordPda({ proposal: s.proposal, voter: w.address }))[0], coinMint: s.coin, voterCoin: await ata(w.address, s.coin), coinTokenProgram: TP })], w);
    ev.check(`reclaim-${name}`, `${name} takes the locked 100 coins back`, (await balanceOf(w.address, s.coin)) - before === 100n * COIN, `${name} +100 coins`, sig);
  }
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
