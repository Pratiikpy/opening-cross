// Backing watchdog (F6; ADR-0655): an asset whose attested backing is missing, stale or short of the live supply is halted
// on chain by anyone, and only a printing resume cross lifts the halt.
import { describe, expect, it } from 'vitest';
import type { Address, KeyPairSigner } from '@solana/kit';
import {
  CrossState,
  Disclosure,
  FLAG_RESUMES_HALT,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  getHaltStateDecoder,
  getInitHaltStateInstruction,
  haltStateAddress,
  protocolAddress,
} from '@opening-cross/sdk';
import {
  findAttestationPda,
  findPolicyPda,
  findWatchdogPda,
  getAttestInstruction,
  getAttestationDecoder,
  getCheckInstruction,
  getCreatePolicyInstruction,
} from '@opening-cross/cross-backing-client';
import { RulesWorld, type RuledOptions } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const MAX_AGE = 3_600n;

async function setup(opts: { coverageBps?: number; supply?: bigint } = {}) {
  const w = await RulesWorld.createRules();
  const mint = w.baseMint;
  const [watchdog] = await findWatchdogPda({ mint });
  const [policy] = await findPolicyPda({ mint });
  const [attestation] = await findAttestationPda({ mint });
  const halt = await haltStateAddress(mint);
  const attester = await w.h.wallet();
  await w.h.send([getInitHaltStateInstruction({ authority: w.admin, baseMint: mint, protocol: await protocolAddress(), halt, venueSigner: watchdog, breaker: null })], w.admin);
  await w.h.send([getCreatePolicyInstruction({ authority: w.admin, mint, halt, watchdog, policy, attester: attester.address, minCoverageBps: opts.coverageBps ?? 10_000, maxAgeSecs: MAX_AGE })], w.admin);
  if (opts.supply) await w.h.fund(mint, w.admin, w.creator.address, opts.supply);
  const attest = (backing: bigint, who: KeyPairSigner = attester) => getAttestInstruction({ attester: who, policy, attestation, backingAtoms: backing });
  const check = () => getCheckInstruction({ policy, mint, attestation, watchdog, halt });
  const halted = () => {
    const a = w.h.svm.getAccount(halt);
    if (!a.exists) throw new Error('halt state missing');
    return getHaltStateDecoder().decode(a.data);
  };
  return { w, mint, watchdog, policy, attestation, halt, attester, attest, check, halted };
}

describe('opting an asset in', () => {
  it('only the halt state authority can, and only when the watchdog is its venue signer', async () => {
    const w = await RulesWorld.createRules();
    const mint = w.baseMint;
    const [watchdog] = await findWatchdogPda({ mint });
    const [policy] = await findPolicyPda({ mint });
    const halt = await haltStateAddress(mint);
    const create = (authority: KeyPairSigner, over: Partial<{ coverage: number; age: bigint }> = {}) =>
      getCreatePolicyInstruction({ authority, mint, halt, watchdog, policy, attester: w.admin.address, minCoverageBps: over.coverage ?? 10_000, maxAgeSecs: over.age ?? MAX_AGE });
    // A halt state whose venue signer is somebody else: the watchdog could never act.
    await w.h.send([getInitHaltStateInstruction({ authority: w.admin, baseMint: mint, protocol: await protocolAddress(), halt, venueSigner: null, breaker: null })], w.admin);
    expect(await w.h.fail([create(w.admin)], w.admin)).toContain('WatchdogNotVenueSigner');
    const stranger = await w.h.wallet();
    expect(await w.h.fail([create(stranger)], stranger)).toContain('Unauthorized');
    expect(await w.h.fail([create(w.admin, { coverage: 99 })], w.admin)).toContain('BadPolicy');
    expect(await w.h.fail([create(w.admin, { coverage: 20_001 })], w.admin)).toContain('BadPolicy');
    expect(await w.h.fail([create(w.admin, { age: 59n })], w.admin)).toContain('BadPolicy');
    expect(await w.h.fail([create(w.admin, { age: 30n * 86_400n + 1n })], w.admin)).toContain('BadPolicy');
  });

  it('is permanent: a second policy for the mint is refused', async () => {
    const s = await setup();
    expect(await s.w.h.fail([getCreatePolicyInstruction({ authority: s.w.admin, mint: s.mint, halt: s.halt, watchdog: s.watchdog, policy: s.policy, attester: s.w.admin.address, minCoverageBps: 100, maxAgeSecs: 60n })], s.w.admin)).toBeTruthy();
  });
});

describe('the pause', () => {
  it('halts an asset nobody has attested for, on a call by anyone', async () => {
    const s = await setup();
    expect(s.halted().halted).toBe(false);
    const stranger = await s.w.h.wallet();
    await s.w.h.send([s.check()], stranger);
    expect(s.halted()).toMatchObject({ halted: true });
  });

  it('does nothing while the backing is fresh and covers the live supply, to the atom', async () => {
    const s = await setup({ supply: 1_000n * TOKEN });
    const stranger = await s.w.h.wallet();
    await s.w.h.send([s.attest(1_000n * TOKEN)], s.attester);
    expect(await s.w.h.fail([s.check()], stranger)).toContain('Backed');
    expect(s.halted().halted).toBe(false);
    // One atom of new supply and the same statement no longer covers it.
    await s.w.h.fund(s.mint, s.w.admin, s.w.creator.address, 1n);
    await s.w.h.send([s.check()], stranger);
    expect(s.halted().halted).toBe(true);
  });

  it('measures coverage against the supply as it is now, not as it was attested', async () => {
    const s = await setup({ coverageBps: 15_000, supply: 100n * TOKEN });
    await s.w.h.send([s.attest(150n * TOKEN)], s.attester);
    expect(await s.w.h.fail([s.check()], s.w.admin)).toContain('Backed');
    await s.w.h.fund(s.mint, s.w.admin, s.w.creator.address, 1n);
    await s.w.h.send([s.check()], s.w.admin);
    expect(s.halted().halted).toBe(true);
  });

  it('halts on a stale statement, and a fresh one does not lift the halt', async () => {
    const s = await setup({ supply: 100n * TOKEN });
    await s.w.h.send([s.attest(100n * TOKEN)], s.attester);
    s.w.h.setTime(T0 + MAX_AGE);
    expect(await s.w.h.fail([s.check()], s.w.admin)).toContain('Backed');
    s.w.h.setTime(T0 + MAX_AGE + 1n);
    await s.w.h.send([s.check()], s.w.admin);
    expect(s.halted().halted).toBe(true);
    // A new statement makes the next check say "backed", but the halt stays until a resume cross prints.
    await s.w.h.send([s.attest(100n * TOKEN)], s.attester);
    expect(await s.w.h.fail([s.check()], s.w.admin)).toContain('Backed');
    expect(s.halted().halted).toBe(true);
  });

  it('only the named attester can attest, and the time of a statement is the chain\'s', async () => {
    const s = await setup();
    const stranger = await s.w.h.wallet();
    expect(await s.w.h.fail([s.attest(1n, stranger)], stranger)).toContain('Unauthorized');
    await s.w.h.send([s.attest(7n)], s.attester);
    const a = getAttestationDecoder().decode((s.w.h.svm.getAccount(s.attestation) as { data: Uint8Array }).data);
    expect(a).toMatchObject({ backingAtoms: 7n, postedTs: T0 });
    s.w.h.setTime(T0 + 100n);
    await s.w.h.send([s.attest(9n)], s.attester);
    expect(getAttestationDecoder().decode((s.w.h.svm.getAccount(s.attestation) as { data: Uint8Array }).data)).toMatchObject({ backingAtoms: 9n, postedTs: T0 + 100n });
  });

  it('checking a policy against another mint\'s accounts is refused', async () => {
    const s = await setup();
    const otherMint = s.w.quoteMint;
    const [otherWatchdog] = await findWatchdogPda({ mint: otherMint });
    const [otherAttestation] = await findAttestationPda({ mint: otherMint });
    const ix = getCheckInstruction({ policy: s.policy, mint: otherMint, attestation: otherAttestation, watchdog: otherWatchdog, halt: await haltStateAddress(otherMint) });
    expect(await s.w.h.fail([ix], s.w.admin)).toBeTruthy();
    expect(s.halted().halted).toBe(false);
  });
});

describe('what a halt does to the asset', () => {
  async function reopen(w: RulesWorld, rules: RuledOptions['rules']) {
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, reference: 1_500_000n, ...(rules ? { rules } : {}) });
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n);
    await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n);
    return w.settle(cross);
  }

  it('an ordinary cross refuses to print once the watchdog has halted the asset, and a resume cross run by the issuer lifts it', async () => {
    const s = await setup({ supply: 100n * TOKEN });
    const w = s.w;
    const rules = { guards: { haltSource: s.halt as Address } };
    await w.h.send([s.attest(100n * TOKEN)], s.attester);
    expect((await reopen(w, rules)).data.state).toBe(CrossState.Cleared);
    // The statement goes stale: anyone halts the asset.
    w.h.setTime(T0 + MAX_AGE + 5n);
    await w.h.send([s.check()], w.guardian);
    expect(s.halted()).toMatchObject({ halted: true });
    const refused = await reopen(w, { ...rules });
    expect(refused.data.state).toBe(CrossState.NoPrint);
    expect(refused.data.noPrintReason).toMatchObject({ __option: 'Some', value: NoPrintReason.Halted });
    // Backing restored; the issuer (the halt authority) runs a resume cross.
    await w.h.send([s.attest(100n * TOKEN)], s.attester);
    w.creator = w.admin;
    await w.h.ata(w.admin.address, w.baseMint, w.admin);
    await w.h.ata(w.admin.address, w.quoteMint, w.admin);
    await w.h.fund(w.quoteMint, w.admin, w.admin.address, 1_000_000_000_000n);
    const printed = await reopen(w, { flags: FLAG_RESUMES_HALT, guards: { haltSource: s.halt as Address } });
    expect(printed.data.state).toBe(CrossState.Cleared);
    expect(s.halted().halted).toBe(false);
  });
});
