// Ownership-coin treasury template (ROADMAP A5, ADR-0014), against the mainnet SAS binary.
// The team spends within a periodic allowance only while an attestation for the treasury is live;
// when it lapses past the grace period anyone can trigger liquidation, and holders redeem pro rata.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, address } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { deriveAttestationPda, deriveCredentialPda, deriveSchemaPda, getCloseAttestationInstruction, getCreateAttestationInstruction, getCreateCredentialInstruction, getCreateSchemaInstruction } from 'sas-lib';
import {
  findTreasuryPda,
  findVaultPda,
  getCreateTreasuryInstruction,
  getRecordAttestedInstruction,
  getRecordLapseInstruction,
  getRedeemInstruction,
  getSpendInstruction,
  getTreasuryDecoder,
  getTriggerLiquidationInstruction,
  TreasuryState,
} from '@opening-cross/treasury-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const SAS = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
const SO = fileURLToPath(new URL('../../fixtures/solana_attestation_service.so', import.meta.url));
const ix = (x: unknown) => x as Instruction; // sas-lib targets kit 5; instructions are plain data
const DAY = 86_400n;

async function setup(opts: { revokeCoinAuthority?: boolean } = {}) {
  const w = await World.create();
  w.h.svm.addProgramFromFile(SAS, SO);
  const team = await w.h.wallet();
  const auditor = await w.h.wallet();
  const [credential] = await deriveCredentialPda({ authority: auditor.address, name: 'treasury-audit' });
  const [schema] = await deriveSchemaPda({ credential, name: 'monthly-report', version: 1 });
  await w.h.send([ix(getCreateCredentialInstruction({ payer: auditor, credential, authority: auditor, name: 'treasury-audit', signers: [auditor.address] } as never))], auditor);
  await w.h.send([ix(getCreateSchemaInstruction({ payer: auditor, authority: auditor, credential, schema, name: 'monthly-report', description: 'Monthly treasury report filed', layout: new Uint8Array([0]), fieldNames: ['ok'] } as never))], auditor);

  // The ownership coin: fixed supply of 1,000 held 600 / 400, then the mint authority is revoked.
  const coin = await w.h.mint(w.admin, 6);
  const alice = await w.trader();
  const bob = await w.trader();
  await w.h.fund(coin, w.admin, alice.address, 600_000_000n);
  await w.h.fund(coin, w.admin, bob.address, 400_000_000n);
  if (opts.revokeCoinAuthority !== false) await w.h.setMintAuthority(coin, w.admin, null);

  const [treasury] = await findTreasuryPda({ coinMint: coin });
  const [vault] = await findVaultPda({ treasury });
  const attest = async (expiry: bigint) => {
    const [attestation] = await deriveAttestationPda({ credential, schema, nonce: treasury });
    await w.h.send([ix(getCreateAttestationInstruction({ payer: auditor, authority: auditor, credential, schema, attestation, nonce: treasury, data: new Uint8Array([1]), expiry } as never))], auditor);
    return attestation;
  };
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: treasury });
  const close = () => w.h.send([ix(getCloseAttestationInstruction({ payer: auditor, authority: auditor, credential, attestation } as never))], auditor);
  const create = getCreateTreasuryInstruction({
    authority: team, coinMint: coin, quoteMint: w.quoteMint, treasury, vault, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    allowance: 1_000_000_000n, periodSecs: 30n * DAY, graceSecs: 7n * DAY, credential, schema,
  });
  const state = () => getTreasuryDecoder().decode((w.h.svm.getAccount(treasury) as { data: Uint8Array }).data);
  const teamQuote = await w.h.ata(team.address, w.quoteMint, w.admin);
  const spend = (amount: bigint, signer = team, att: Address = attestation) =>
    getSpendInstruction({ authority: signer, treasury, attestation: att, quoteMint: w.quoteMint, vault, destination: teamQuote, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
  const redeem = async (holder: Awaited<ReturnType<typeof w.trader>>, amount: bigint) =>
    getRedeemInstruction({ holder, treasury, coinMint: coin, quoteMint: w.quoteMint, holderCoin: await w.h.ata(holder.address, coin, w.admin), holderQuote: await w.h.ata(holder.address, w.quoteMint, w.admin), vault, coinTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
  return { w, team, alice, bob, coin, treasury, vault, attestation, attest, close, create, state, spend, redeem, teamQuote };
}

describe.skipIf(!existsSync(SO))('ownership-coin treasury', () => {
  it('refuses a coin whose supply is not fixed', async () => {
    const s = await setup({ revokeCoinAuthority: false });
    expect(await s.w.h.fail([s.create], s.team)).toContain('SupplyNotFixed');
  });

  it('the team spends within the allowance, only while attested; periods reset; nobody else can spend', async () => {
    const s = await setup();
    await s.w.h.send([s.create], s.team);
    // Treasury funds arrive by plain transfer (e.g. a cross's proceeds go straight to the vault).
    await s.w.h.send([await (await import('@solana-program/token-2022')).getMintToInstruction({ mint: s.w.quoteMint, token: s.vault, mintAuthority: s.w.admin, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], s.w.admin);

    expect(await s.w.h.fail([s.spend(1n)], s.team)).toContain('NotAttested'); // no attestation yet
    await s.attest(T0 + 40n * DAY);
    await s.w.h.send([s.spend(600_000_000n)], s.team);
    await s.w.h.send([s.spend(400_000_000n)], s.team);
    expect(await s.w.h.fail([s.spend(1n)], s.team)).toContain('OverAllowance');
    const stranger = await s.w.h.wallet();
    expect(await s.w.h.fail([s.spend(1n, stranger)], stranger)).toMatch(/Unauthorized/);
    expect(await s.w.h.fail([s.spend(1n, s.team, s.w.quoteMint)], s.team)).toContain('WrongAttestationAccount');
    s.w.h.setTime(T0 + 30n * DAY); // next period
    await s.w.h.send([s.spend(1_000_000_000n)], s.team);
    expect(s.w.h.balance(s.teamQuote)).toBe(2_000_000_000n);
  });

  it('a lapse past the grace period lets anyone liquidate; holders redeem pro rata and the team can no longer spend', async () => {
    const s = await setup();
    await s.w.h.send([s.create], s.team);
    await s.w.h.send([await (await import('@solana-program/token-2022')).getMintToInstruction({ mint: s.w.quoteMint, token: s.vault, mintAuthority: s.w.admin, amount: 10_000_000_001n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], s.w.admin);
    await s.attest(T0 + 10n * DAY);
    const anyone = await s.w.h.wallet();
    const observe = { treasury: s.treasury, attestation: s.attestation };
    expect(await s.w.h.fail([getRecordLapseInstruction(observe)], anyone)).toContain('StillAttested');
    expect(await s.w.h.fail([getTriggerLiquidationInstruction({ treasury: s.treasury, coinMint: s.coin, vault: s.vault })], anyone)).toContain('NoLapse');
    expect(await s.w.h.fail([await s.redeem(s.alice, 1n)], s.alice)).toContain('NotLiquidating');

    s.w.h.setTime(T0 + 10n * DAY); // the attestation expires
    await s.w.h.send([getRecordLapseInstruction(observe)], anyone);
    expect(await s.w.h.fail([s.spend(1n)], s.team)).toContain('NotAttested');
    s.w.h.setTime(T0 + 16n * DAY);
    expect(await s.w.h.fail([getTriggerLiquidationInstruction({ treasury: s.treasury, coinMint: s.coin, vault: s.vault })], anyone)).toContain('GraceNotOver');
    s.w.h.setTime(T0 + 17n * DAY);
    await s.w.h.send([getTriggerLiquidationInstruction({ treasury: s.treasury, coinMint: s.coin, vault: s.vault })], anyone);
    const st = s.state();
    expect(st.state).toBe(TreasuryState.Liquidating);
    expect([st.snapshotVault, st.snapshotSupply]).toEqual([10_000_000_001n, 1_000_000_000n]);

    // A renewed attestation can no longer revive a treasury in liquidation.
    await s.close();
    await s.attest(T0 + 60n * DAY);
    expect(await s.w.h.fail([s.spend(1n)], s.team)).toContain('Liquidating');
    expect(await s.w.h.fail([getRecordAttestedInstruction(observe)], anyone)).toContain('Liquidating');

    // Holders redeem: 600 and 400 of 1,000 coins against 10,000.000001 quote (floors, never over).
    await s.w.h.send([await s.redeem(s.alice, 600_000_000n)], s.alice);
    await s.w.h.send([await s.redeem(s.bob, 400_000_000n)], s.bob);
    expect(await s.w.h.balanceOf(s.alice.address, s.w.quoteMint)).toBe(6_000_000_000n);
    expect(await s.w.h.balanceOf(s.bob.address, s.w.quoteMint)).toBe(4_000_000_000n);
    expect(s.w.h.balance(s.vault)).toBe(1n); // rounding dust stays, never paid twice
    expect(await s.w.h.balanceOf(s.alice.address, s.coin)).toBe(0n);
    // Redeeming coins you do not have fails.
    expect(await s.w.h.fail([await s.redeem(s.alice, 1n)], s.alice)).toMatch(/insufficient|0x1/i);
  });

  it('a renewed attestation clears a recorded lapse before the grace period ends', async () => {
    const s = await setup();
    await s.w.h.send([s.create], s.team);
    await s.attest(T0 + DAY);
    const anyone = await s.w.h.wallet();
    const observe = { treasury: s.treasury, attestation: s.attestation };
    s.w.h.setTime(T0 + DAY);
    await s.w.h.send([getRecordLapseInstruction(observe)], anyone);
    await s.close();
    await s.attest(T0 + 60n * DAY);
    await s.w.h.send([getRecordAttestedInstruction(observe)], anyone);
    s.w.h.setTime(T0 + 30n * DAY);
    expect(await s.w.h.fail([getTriggerLiquidationInstruction({ treasury: s.treasury, coinMint: s.coin, vault: s.vault })], anyone)).toContain('NoLapse');
    expect(s.state().state).toBe(TreasuryState.Active);
  });
});
