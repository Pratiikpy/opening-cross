// The extension tail (ADR-0450): a cross made by the deployed program keeps working after the upgrade, rules are
// set once, by the creator, in the creating slot and before any order, and a cross without rules behaves as before.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  completeRules,
  getCrossDecoder,
  getSetRulesInstruction,
  readCrossExt,
  readCrossExtRaw,
  type RulesConfig,
} from '@opening-cross/sdk';
import { RulesWorld } from '../src/rules-world.js';
import { T0, salt } from '../src/harness.js';

const BASELINE = `${process.env.OC_BASELINE_DIR ?? `${process.env.HOME}/oc-baseline`}/cross_core.so`;
const NEW = `${process.env.OC_DEPLOY_DIR ?? ''}/cross_core.so`;
const schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }];

describe('the extension tail', () => {
  it('is allocated with every new cross and reads as "no rules" until they are set', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule });
    const acc = w.h.svm.getAccount(cross.address);
    if (!acc.exists) throw new Error('missing');
    expect(acc.data.length).toBe(CROSS_BODY_LEN + CROSS_EXT_LEN);
    expect(cross.ext).toBeNull();
    const raw = readCrossExtRaw(acc.data);
    expect(raw?.version).toBe(1);
    expect(raw?.rulesSet).toBe(false);
  });

  it('a cross created by the deployed program is settled by the upgraded one, with no migration', async () => {
    expect(existsSync(BASELINE), `baseline binary at ${BASELINE}`).toBe(true);
    expect(existsSync(NEW), `new binary at ${NEW}`).toBe(true);
    const w = await RulesWorld.createRules();
    // The deployed (baseline) program creates a cross, takes orders, and is then replaced by the new build.
    w.h.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, BASELINE);
    const cross = await w.newCross({ supplyMode: SupplyMode.Mint, disclosure: Disclosure.Sealed, schedule });
    const acc0 = w.h.svm.getAccount(cross.address);
    if (!acc0.exists) throw new Error('missing');
    expect(acc0.data.length).toBe(CROSS_BODY_LEN); // no tail
    const a = await w.place(cross, await w.trader(1_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    const b = await w.place(cross, await w.trader(1_000_000_000n), OrderSide.Buy, 1_200_000n, 50_000_000n);
    const unrevealed = await w.place(cross, await w.trader(1_000_000_000n), OrderSide.Buy, 1_100_000n, 10_000_000n, { reveal: false });
    w.h.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, NEW);
    await w.revealAll(cross, [a, b, unrevealed]);
    const cleared = await w.settle(cross);
    expect(cleared.data.state).toBe(CrossState.Cleared);
    await w.claimAll(cleared, [a, b, unrevealed]);
    expect(await w.h.balanceOf(a.owner.address, cleared.data.baseMint)).toBe(100_000_000n);
    expect(await w.h.balanceOf(unrevealed.owner.address, cleared.data.quoteMint)).toBe(1_000_000_000n); // never revealed: refunded in full
    const final = await w.finalize(cleared);
    expect(final.data.state).toBe(CrossState.Finalized);
  });

  it('refuses rules on a cross that was created without a tail', async () => {
    const w = await RulesWorld.createRules();
    w.h.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, BASELINE);
    const legacy = await w.newCross({ supplyMode: SupplyMode.Mint, schedule });
    w.h.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, NEW);
    const ix = getSetRulesInstruction({ creator: w.creator, cross: legacy.address, ...completeRules({ guards: { minRaiseQuote: 1n } }) });
    expect(await w.h.fail([ix], w.creator)).toMatch(/LegacyCross/);
  });

  it('rules are fixed once: by the creator, in the creating slot, before any order', async () => {
    const w = await RulesWorld.createRules();
    const rules = { guards: { minRaiseQuote: 1_000n } };
    // Not in the creating slot: create alone, then set_rules one slot later.
    await expect(w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules, rulesAfterSlots: 1n })).rejects.toThrow(/RulesLocked/);
    // In the creating slot, as a separate transaction, it is accepted.
    const sameSlot = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules, rulesAfterSlots: 0n });
    expect(sameSlot.ext?.rulesSet).toBe(true);

    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules });
    expect(cross.ext?.rulesSet).toBe(true);
    expect(cross.ext?.guards.minRaiseQuote).toBe(1_000n);
    // Twice: refused.
    const again = getSetRulesInstruction({ creator: w.creator, cross: cross.address, ...completeRules({ guards: { minRaiseQuote: 1n } }) });
    expect(await w.h.fail([again], w.creator)).toMatch(/RulesLocked/);
    // Someone else: refused.
    const stranger = await w.h.wallet();
    const other = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule });
    const bad = getSetRulesInstruction({ creator: stranger, cross: other.address, ...completeRules() });
    expect(await w.h.fail([bad], stranger)).toMatch(/Unauthorized/);
  });

  it('an order closes the door on rules even in the creating slot', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule });
    const t = await w.trader(1_000_000_000n);
    await w.h.send([await w.commitIx(w.view(cross.address), t, 0n, OrderSide.Buy, 1_500_000n, 1_000_000n, salt())], t);
    const ix = getSetRulesInstruction({ creator: w.creator, cross: cross.address, ...completeRules({ guards: { minRaiseQuote: 1n } }) });
    expect(await w.h.fail([ix], w.creator)).toMatch(/RulesLocked/);
  });

  it('the tail is invisible to the generated decoders', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { guards: { minRaiseQuote: 5n } } });
    const acc = w.h.svm.getAccount(cross.address);
    if (!acc.exists) throw new Error('missing');
    expect(getCrossDecoder().decode(acc.data).creator).toBe(w.creator.address);
    expect(readCrossExt(acc.data)?.guards.minRaiseQuote).toBe(5n);
  });

  it('rejects inconsistent rules', async () => {
    const w = await RulesWorld.createRules();
    const attempt = async (rules: RulesConfig) => {
      await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules });
    };
    await expect(attempt({ flags: 1 })).rejects.toThrow(/InvalidParams/); // bit 0 was never assigned
    await expect(attempt({ ending: { endingSecs: 10, buckets: 0 } })).rejects.toThrow(/InvalidParams/);
    await expect(attempt({ ending: { endingSecs: 200, buckets: 4 } })).rejects.toThrow(/InvalidParams/); // longer than the call
    await expect(attempt({ ending: { endingSecs: 40, buckets: 1, randomEnd: true } })).rejects.toThrow(/InvalidParams/);
    await expect(attempt({ guards: { minFloatBps: 10_001, totalSupply: 5n } })).rejects.toThrow(/InvalidParams/);
    await expect(attempt({ identity: { capQuote: 5n } })).rejects.toThrow(/InvalidParams/); // an identity cap needs a gate
    await expect(attempt({ referral: { shareBps: 5_001, referrer: w.admin.address } })).rejects.toThrow(/InvalidParams/);
    await expect(attempt({ referral: { shareBps: 100 } })).rejects.toThrow(/InvalidParams/); // a share with no referrer
    await expect(attempt({ referral: { referrer: w.admin.address } })).rejects.toThrow(/InvalidParams/); // a referrer with no share
    // Locks need a mint that exists and is not under a hook: refused on a deferred-mint cross.
    await expect(
      w.newRuledCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: w.admin.address, settleDeadlineTs: T0 + 1_000n, rules: { neutrality: { insiders: [w.admin.address], insiderCliffSecs: 10 } } }),
    ).rejects.toThrow(/InvalidParams/);
  });
});
