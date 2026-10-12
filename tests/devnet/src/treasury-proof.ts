// Devnet proof for the ownership-coin treasury (ROADMAP A5, ADR-0014): a spend allowance per period, spending only
// while a real SAS attestation for the treasury is live, a lapse, the grace period, liquidation, and pro-rata
// redemption by coin holders. The treasury takes its period, grace and attestation expiry as parameters, so the whole
// lifecycle runs on the cluster's real clock in a few minutes.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:treasury
import { type Address, type KeyPairSigner, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintToInstruction } from '@solana-program/token-2022';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCloseAttestationInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import {
  TreasuryState,
  TREASURY_PROGRAM_ADDRESS,
  findTreasuryPda,
  findVaultPda,
  getCreateTreasuryInstruction,
  getRecordAttestedInstruction,
  getRecordLapseInstruction,
  getRedeemInstruction,
  getSpendInstruction,
  getTreasuryDecoder,
  getTriggerLiquidationInstruction,
} from '@opening-cross/treasury-client';
import { Evidence } from './lib.js';
import { accountData, asIx, ata, ataIx, balanceOf, chainTime, exists, freshFunder, fundWallets, mintTo, mustFail, newMint, revokeMintAuthority, send, sleep, sweepBack, tokenBalance, waitUntil } from './kit.js';

const SAS_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
const ev = new Evidence('A5-treasury-devnet.md', 'Devnet proof — ownership-coin treasury: allowance, attestation-gated release, lapse and liquidation (A5)', [
  'Script `tests/devnet/src/treasury-proof.ts` (`dp:treasury`). Real devnet transactions; expected refusals are simulated against the deployed program, so nothing failed is billed or recorded.',
  `Programs: treasury \`${TREASURY_PROGRAM_ADDRESS}\`, Solana Attestation Service \`${SAS_ADDRESS}\`. Funder, team, auditor (the SAS issuer), two coin holders and a stranger are throwaway keys funded from the devnet promiser key.`,
  'The treasury program takes `period_secs`, `grace_secs` and the attestation expiry as parameters, so this run uses a 90-second allowance period and a 45-second grace period on the real cluster clock. Production values (30-day period, 7-day grace) are the same code path with larger numbers; they are not exercised here.',
  '',
  'Not covered: a real auditor. The attestation issuer is a throwaway key, so this proves the mechanism and not any real audit process (HUMAN H2). Multi-period spending over days and a grace period of days are not run; the one period reset and the grace expiry are run at their short settings. Where treasury proceeds come from (a cross paying straight into the vault) is covered by the cross proofs, not here: the vault is funded here by a plain mint of the quote token.',
]);

let cleanup: (() => Promise<void>) | undefined;

async function main() {
  const { funder, promiser } = await freshFunder(260_000_000n);
  cleanup = async () => {
    const back = await sweepBack(funder, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  const [team, auditor, alice, bob, stranger] = await Promise.all([1, 2, 3, 4, 5].map(() => generateKeyPairSigner()));
  await fundWallets(funder, [team!.address, alice!.address, bob!.address, stranger!.address], 8_000_000n);
  await fundWallets(funder, [auditor!.address], 20_000_000n);

  // SAS credential and schema owned by the auditor.
  const credName = `treasury-audit-${Date.now()}`;
  const [credential] = await deriveCredentialPda({ authority: auditor!.address, name: credName });
  const [schema] = await deriveSchemaPda({ credential, name: 'monthly-report', version: 1 });
  await send([asIx(getCreateCredentialInstruction({ payer: auditor, credential, authority: auditor, name: credName, signers: [auditor!.address] } as never))], auditor!);
  await send([asIx(getCreateSchemaInstruction({ payer: auditor, authority: auditor, credential, schema, name: 'monthly-report', description: 'Monthly treasury report filed', layout: new Uint8Array([0]), fieldNames: ['ok'] } as never))], auditor!);
  ev.check('sas-setup', 'an auditor creates a SAS credential and schema on devnet', (await exists(credential)) && (await exists(schema)), `credential ${credential}, schema ${schema}`);

  const quoteMint = await newMint(funder, funder.address);
  await send([await ataIx(funder, team!.address, quoteMint), await ataIx(funder, alice!.address, quoteMint), await ataIx(funder, bob!.address, quoteMint)], funder);
  const teamQuote = await ata(team!.address, quoteMint);

  /** A fresh ownership coin held 600 / 400 by alice and bob, plus a treasury over it. */
  const newTreasury = async (o: { allowance: bigint; periodSecs: bigint; graceSecs: bigint; fixSupply: boolean }) => {
    const coin = await newMint(funder, funder.address);
    await mintTo(funder, coin, alice!.address, funder, 600_000_000n);
    await mintTo(funder, coin, bob!.address, funder, 400_000_000n);
    const [treasury] = await findTreasuryPda({ coinMint: coin });
    const [vault] = await findVaultPda({ treasury });
    const create = getCreateTreasuryInstruction({
      authority: team!, coinMint: coin, quoteMint, treasury, vault, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      allowance: o.allowance, periodSecs: o.periodSecs, graceSecs: o.graceSecs, credential, schema,
    });
    return { coin, treasury, vault, create, fixSupply: () => revokeMintAuthority(funder, coin, funder) };
  };
  const attestationOf = async (treasury: Address): Promise<Address> => (await deriveAttestationPda({ credential, schema, nonce: treasury }))[0];
  const attest = async (treasury: Address, expiry: bigint) => {
    const attestation = await attestationOf(treasury);
    const sig = await send([asIx(getCreateAttestationInstruction({ payer: auditor, authority: auditor, credential, schema, attestation, nonce: treasury, data: new Uint8Array([1]), expiry } as never))], auditor!);
    return { attestation, sig };
  };
  const closeAtt = async (attestation: Address) => send([asIx(getCloseAttestationInstruction({ payer: auditor, authority: auditor, credential, attestation } as never))], auditor!);
  const state = async (treasury: Address) => getTreasuryDecoder().decode(await accountData(treasury));
  const spend = (t: { treasury: Address; vault: Address }, attestation: Address, amount: bigint, signer: KeyPairSigner = team!) =>
    getSpendInstruction({ authority: signer, treasury: t.treasury, attestation, quoteMint, vault: t.vault, destination: teamQuote, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
  const fundVault = (vault: Address, amount: bigint) =>
    send([getMintToInstruction({ mint: quoteMint, token: vault, mintAuthority: funder, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], funder);
  const record = async (ix: ReturnType<typeof getRecordLapseInstruction>) => {
    for (let i = 0; i < 15; i++) {
      try { return await send([ix], stranger!); } catch (e) { if (i === 14) throw e; await sleep(2_000); }
    }
    throw new Error('unreachable');
  };

  // ------------------------------------------------------------------ Scenario A: allowance, lapse, liquidation, redemption
  const A = await newTreasury({ allowance: 1_000_000_000n, periodSecs: 90n, graceSecs: 45n, fixSupply: true });
  ev.check('refuse-open-supply', 'a coin whose mint authority is still set is refused (SupplyNotFixed)', true, await mustFail([A.create], team!, 'SupplyNotFixed'));
  await A.fixSupply();
  const createSig = await send([A.create], team!);
  await fundVault(A.vault, 10_000_000_001n);
  const s0 = await state(A.treasury);
  ev.check('create', 'the treasury is created over a fixed-supply coin with a 1,000-quote allowance per 90 s period', s0.state === TreasuryState.Active && s0.allowance === 1_000_000_000n && s0.periodSecs === 90n && s0.graceSecs === 45n, `treasury ${A.treasury}, vault ${A.vault} holds ${await tokenBalance(A.vault)}`, createSig);
  const attestation = await attestationOf(A.treasury);
  ev.check('refuse-unattested-spend', 'the team cannot spend before any attestation exists (NotAttested)', true, await mustFail([spend(A, attestation, 1n)], team!, 'NotAttested'));
  ev.check('refuse-liquidate-without-lapse', 'nobody can start liquidation without a recorded lapse (NoLapse)', true, await mustFail([getTriggerLiquidationInstruction({ treasury: A.treasury, coinMint: A.coin, vault: A.vault })], stranger!, 'NoLapse'));
  const earlyRedeem = getRedeemInstruction({ holder: alice!, treasury: A.treasury, coinMint: A.coin, quoteMint, holderCoin: await ata(alice!.address, A.coin), holderQuote: await ata(alice!.address, quoteMint), vault: A.vault, coinTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount: 1n });
  ev.check('refuse-early-redeem', 'holders cannot redeem before liquidation (NotLiquidating)', true, await mustFail([earlyRedeem], alice!, 'NotLiquidating'));

  const expiry = (await chainTime()) + 115n;
  const att = await attest(A.treasury, expiry);
  ev.check('attest', "the auditor's SAS attestation for the treasury exists on devnet", await exists(att.attestation), `attestation ${att.attestation}, expiry ${expiry}`, att.sig);
  const sp1 = await send([spend(A, attestation, 600_000_000n)], team!);
  await send([spend(A, attestation, 400_000_000n)], team!);
  ev.check('spend-within-allowance', 'while attested the team spends its full allowance (600 + 400)', (await tokenBalance(teamQuote)) === 1_000_000_000n, `team received ${await tokenBalance(teamQuote)}`, `${sp1}`);
  ev.check('refuse-over-allowance', 'one more atom in the same period is refused (OverAllowance)', true, await mustFail([spend(A, attestation, 1n)], team!, 'OverAllowance'));
  ev.check('refuse-stranger-spend', 'a non-authority cannot spend (Unauthorized)', true, await mustFail([spend(A, attestation, 1n, stranger!)], stranger!, 'Unauthorized'));
  ev.check('refuse-wrong-attestation', 'the wrong attestation account is refused (WrongAttestationAccount)', true, await mustFail([spend(A, quoteMint, 1n)], team!, 'WrongAttestationAccount'));

  await waitUntil(s0.periodStart + 91n);
  const sp3 = await send([spend(A, attestation, 1_000_000_000n)], team!);
  ev.check('period-reset', 'after the 90 s period the allowance resets and the team spends another 1,000', (await tokenBalance(teamQuote)) === 2_000_000_000n, `team holds ${await tokenBalance(teamQuote)}`, sp3);
  ev.check('refuse-lapse-while-attested', 'while the attestation is live nobody can record a lapse (StillAttested)', true, await mustFail([getRecordLapseInstruction({ treasury: A.treasury, attestation })], stranger!, 'StillAttested'));

  await waitUntil(expiry);
  const lapseSig = await record(getRecordLapseInstruction({ treasury: A.treasury, attestation }));
  const s1 = await state(A.treasury);
  const lapsedAt = s1.lapsedSince.__option === 'Some' ? s1.lapsedSince.value : null;
  ev.check('lapse', 'once the attestation expires anyone records the lapse, starting the grace clock', lapsedAt !== null && lapsedAt >= expiry, `lapsedSince ${lapsedAt} (expiry ${expiry})`, lapseSig);
  ev.check('refuse-spend-lapsed', 'spending stops while the attestation is lapsed (NotAttested)', true, await mustFail([spend(A, attestation, 1n)], team!, 'NotAttested'));
  ev.check('refuse-liquidate-in-grace', 'liquidation inside the grace period is refused (GraceNotOver)', true, await mustFail([getTriggerLiquidationInstruction({ treasury: A.treasury, coinMint: A.coin, vault: A.vault })], stranger!, 'GraceNotOver'));

  await waitUntil(lapsedAt! + 46n);
  const liqIx = getTriggerLiquidationInstruction({ treasury: A.treasury, coinMint: A.coin, vault: A.vault });
  let liqSig = '';
  for (let i = 0; i < 15 && !liqSig; i++) { try { liqSig = await send([liqIx], stranger!); } catch (e) { if (i === 14) throw e; await sleep(2_000); } }
  const s2 = await state(A.treasury);
  const vaultAtLiquidation = await tokenBalance(A.vault);
  ev.check('liquidation', 'after the grace period anyone triggers liquidation; the vault and coin supply are snapshotted', s2.state === TreasuryState.Liquidating && s2.snapshotVault === vaultAtLiquidation && s2.snapshotSupply === 1_000_000_000n, `snapshot vault ${s2.snapshotVault}, supply ${s2.snapshotSupply}`, liqSig);

  await closeAtt(attestation);
  await attest(A.treasury, (await chainTime()) + 3_600n);
  ev.check('refuse-revival-spend', 'a renewed attestation cannot revive a liquidating treasury for spending (Liquidating)', true, await mustFail([spend(A, attestation, 1n)], team!, 'Liquidating'));
  ev.check('refuse-revival-record', 'nor clear the lapse (Liquidating)', true, await mustFail([getRecordAttestedInstruction({ treasury: A.treasury, attestation })], stranger!, 'Liquidating'));

  const redeem = async (holder: KeyPairSigner, amount: bigint) =>
    getRedeemInstruction({ holder, treasury: A.treasury, coinMint: A.coin, quoteMint, holderCoin: await ata(holder.address, A.coin), holderQuote: await ata(holder.address, quoteMint), vault: A.vault, coinTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
  const snap = s2.snapshotVault;
  const aliceDue = (snap * 600_000_000n) / 1_000_000_000n;
  const bobDue = (snap * 400_000_000n) / 1_000_000_000n;
  const rA = await send([await redeem(alice!, 600_000_000n)], alice!);
  await send([await redeem(bob!, 400_000_000n)], bob!);
  const gotA = await balanceOf(alice!.address, quoteMint);
  const gotB = await balanceOf(bob!.address, quoteMint);
  ev.check('redeem', 'holders redeem pro rata (floor), exactly the snapshot share of the vault', gotA === aliceDue && gotB === bobDue, `alice ${gotA} (expected ${aliceDue}), bob ${gotB} (expected ${bobDue}) of snapshot ${snap}`, rA);
  const dust = await tokenBalance(A.vault);
  ev.check('redeem-conserves', 'the vault keeps only rounding dust and the redeemed coins are burned', dust === snap - aliceDue - bobDue && (await balanceOf(alice!.address, A.coin)) === 0n, `vault left ${dust}`);
  ev.check('refuse-double-redeem', 'redeeming coins you no longer hold is refused', true, await mustFail([await redeem(alice!, 1n)], alice!, 'insufficient funds'));

  // ------------------------------------------------------------------ Scenario B: a renewed attestation before the grace ends clears the lapse
  const B = await newTreasury({ allowance: 1_000_000_000n, periodSecs: 600n, graceSecs: 600n, fixSupply: true });
  await B.fixSupply();
  await send([B.create], team!);
  const attB = await attestationOf(B.treasury);
  const expB = (await chainTime()) + 40n;
  await attest(B.treasury, expB);
  await waitUntil(expB);
  await record(getRecordLapseInstruction({ treasury: B.treasury, attestation: attB }));
  const lapsedB = (await state(B.treasury)).lapsedSince.__option === 'Some';
  ev.check('b-lapse', 'a second treasury lapses when its attestation expires', lapsedB, 'lapsedSince recorded');
  await closeAtt(attB);
  await attest(B.treasury, (await chainTime()) + 3_600n);
  const clearSig = await send([getRecordAttestedInstruction({ treasury: B.treasury, attestation: attB })], stranger!);
  const sB = await state(B.treasury);
  ev.check('b-renewal-clears-lapse', 'a renewed attestation inside the grace period clears the recorded lapse; the treasury stays Active', sB.lapsedSince.__option === 'None' && sB.state === TreasuryState.Active, `state ${String(sB.state)}`, clearSig);
  ev.check('b-no-liquidation', 'liquidation is then refused (NoLapse)', true, await mustFail([getTriggerLiquidationInstruction({ treasury: B.treasury, coinMint: B.coin, vault: B.vault })], stranger!, 'NoLapse'));
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
