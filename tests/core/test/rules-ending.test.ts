// The hard-to-game ending (ADR-0452): bucketed ending period, cancel cutoff, drawn end, extension.
import { describe, expect, it } from 'vitest';
import {
  CrossState,
  Disclosure,
  NO_BUCKET,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  getDrawBeginInstruction,
  getDrawFinishInstruction,
  SLOT_HASHES,
  coarseIndicative,
  getMergeShardInstruction,
  bookAddress,
  shardAddress,
  readOrderExt,
  orderAddress,
  type CrossView,
} from '@opening-cross/sdk';
import type { PlacedOrder } from '../src/world.js';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';
import { expectedSeed, slotHashesFor } from '../src/draws.js';

const schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }];
const ENDING = { endingSecs: 80, buckets: 4, cancelCutoffSecs: 10, randomEnd: true };
// call window T0 .. T0+100: ending period T0+20 .. T0+100 in four buckets of 20 s; cancels close at T0+10.
const at = (w: RulesWorld, secs: bigint) => w.h.setTime(T0 + secs);

const draw = (w: RulesWorld, v: { address: string }, purpose: number, epoch = 0) => w.draw(v.address as never, purpose, epoch);

describe('ending buckets, cancel cutoff, drawn end', () => {
  async function bucketed() {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, schedule, rules: { ending: ENDING } });
    const times = [5n, 25n, 45n, 65n, 85n];
    const placed: PlacedOrder[] = [];
    for (const t of times) {
      at(w, t);
      placed.push(await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n));
    }
    return { w, cross, placed };
  }

  it('puts each order in the bucket of the moment it landed', async () => {
    const { w, cross, placed } = await bucketed();
    const buckets = [];
    for (const o of placed) {
      const acc = w.h.svm.getAccount(await orderAddress(cross.address, o.owner.address, o.nonce));
      if (!acc.exists) throw new Error('order');
      buckets.push(readOrderExt(acc.data).bucket);
    }
    expect(buckets).toEqual([NO_BUCKET, 0, 1, 2, 3]);
  });

  it('cancels close before the ending period and stay closed', async () => {
    const { w, cross, placed } = await bucketed();
    // The order placed at T0+5 could still be cancelled before T0+10; by T0+85 nobody can cancel.
    at(w, 90n);
    await expect(w.cancel(cross, placed[0]!)).rejects.toThrow(/CancelClosed/);
    await expect(w.cancel(cross, placed[4]!)).rejects.toThrow(/CancelClosed/);
    const early = await RulesWorld.createRules();
    const c2 = await early.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { ending: ENDING } });
    at(early, 3n);
    const o = await early.place(c2, await early.trader(10_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    at(early, 8n);
    await early.cancel(c2, o);
    at(early, 12n);
    const late = await early.place(c2, await early.trader(10_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    await expect(early.cancel(c2, late)).rejects.toThrow(/CancelClosed/);
  });

  it('cannot clear before the draw; the drawn end decides which buckets count; later buckets are refunded', async () => {
    const { w, cross, placed } = await bucketed();
    w.h.setTime(cross.data.closeTs + 1n);
    // The clear needs the draw first.
    const ixs = await w.settleIxs(w.view(cross.address));
    expect(await w.h.fail([ixs[ixs.length - 1]!], w.admin)).toMatch(/DrawRequired|ShardsNotMerged/);
    // A draw may not finish at once.
    const begun = w.h.svm.getClock().slot + 1n;
    w.h.svm.warpToSlot(begun);
    await w.h.send([getDrawBeginInstruction({ cross: cross.address })], w.admin);
    expect(await w.h.fail([getDrawFinishInstruction({ cross: cross.address, slotHashes: SLOT_HASHES })], w.admin)).toMatch(/DrawPending/);
    w.h.svm.warpToSlot(begun + 25n);
    slotHashesFor(w, begun - 5n, begun + 25n);
    await w.h.send([getDrawFinishInstruction({ cross: cross.address, slotHashes: SLOT_HASHES })], w.admin);
    const seed = expectedSeed(cross.address, 0, 1, begun);
    const end = Number(seed.readBigUInt64LE(0) % 4n);
    const view = w.view(cross.address);
    expect(view.ext?.draw.endBucket).toBe(end);
    expect(Buffer.from(view.ext!.draw.seed).equals(seed)).toBe(true);

    // A bucket after the end can never be merged.
    if (end < 3) {
      const book = await bookAddress(cross.address);
      const merge = getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, 32 + end + 1) });
      expect(await w.h.fail([merge], w.admin)).toMatch(/BucketExcluded/);
    }
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    const settled = w.view(cross.address);
    expect(settled.data.state).toBe(CrossState.Cleared);
    // Orders: the early one (no bucket) always counts, bucket b counts when b <= end.
    const counted = placed.filter((_, i) => i === 0 || i - 1 <= end);
    const clearing = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
    expect(clearing?.matched).toBe(BigInt(counted.length) * 100_000_000n);
    await w.claimAll(settled, placed);
    for (const [i, o] of placed.entries()) {
      const got = await w.h.balanceOf(o.owner.address, settled.data.baseMint);
      expect(got).toBe(counted.includes(o) ? 100_000_000n : 0n);
      void i;
    }
    const final = await w.finalize(settled);
    expect(final.data.state).toBe(CrossState.Finalized);
  });

  it('a draw whose block hashes have left the sysvar is void and can be started again', async () => {
    const { w, cross } = await bucketed();
    w.h.setTime(cross.data.closeTs + 1n);
    const begun = w.h.svm.getClock().slot + 1n;
    w.h.svm.warpToSlot(begun);
    await w.h.send([getDrawBeginInstruction({ cross: cross.address })], w.admin);
    // The sysvar no longer reaches back to the target slots.
    w.h.svm.warpToSlot(begun + 600n);
    slotHashesFor(w, begun + 100n, begun + 600n);
    expect(await w.h.fail([getDrawFinishInstruction({ cross: cross.address, slotHashes: SLOT_HASHES })], w.admin)).toMatch(/DrawExpired/);
    await w.h.send([getDrawBeginInstruction({ cross: cross.address })], w.admin);
  });
});

describe('the extension', () => {
  it('a cross that fails to print gets one drawn extension; a second failure is final', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      disclosure: Disclosure.Open,
      schedule,
      minMatched: 150_000_000n,
      rules: { ending: { extensionMinSecs: 60, extensionMaxSecs: 120 } },
    });
    at(w, 10n);
    const a = await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    w.h.setTime(cross.data.closeTs + 1n);
    // First clear: 100 < 150 minimum, so the cross waits for its extension instead of giving up.
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    let v = w.view(cross.address);
    expect(v.data.state).toBe(CrossState.Live);
    expect(v.ext?.draw.extPending).toBe(true);
    // The extension draw sets the new close, inside the published range.
    const d = await draw(w, v, 2);
    v = w.view(cross.address);
    expect(v.ext?.draw.epoch).toBe(1);
    expect(v.ext?.draw.extPending).toBe(false);
    const len = BigInt(60) + (d.seed.readBigUInt64LE(8) % 61n);
    const now = w.h.svm.getClock().unixTimestamp;
    expect(v.data.closeTs).toBe(now + len);
    // New orders in the extension window go to the extension shards and count; the first window's order stays.
    const b = await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, 1_500_000n, 80_000_000n);
    const acc = w.h.svm.getAccount(await orderAddress(cross.address, b.owner.address, b.nonce));
    if (!acc.exists) throw new Error('order');
    expect(readOrderExt(acc.data).epoch).toBe(1);
    await expect(w.cancel(cross, b)).rejects.toThrow(/CancelClosed/);
    w.h.setTime(v.data.revealEndTs + 1n);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    v = w.view(cross.address);
    expect(v.data.state).toBe(CrossState.Cleared);
    expect(v.data.clearing.__option === 'Some' ? v.data.clearing.value.matched : 0n).toBe(180_000_000n);
    await w.claimAll(v, [a, b]);
    expect((await w.finalize(v)).data.state).toBe(CrossState.Finalized);
  });

  it('after the extension a failure is final and refunds everyone', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      minMatched: 900_000_000n,
      rules: { ending: { extensionMinSecs: 60, extensionMaxSecs: 60 } },
    });
    at(w, 10n);
    const a = await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    w.h.setTime(cross.data.closeTs + 1n);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    await draw(w, w.view(cross.address), 2);
    w.h.setTime(w.view(cross.address).data.revealEndTs + 1n);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    const v = w.view(cross.address);
    expect(v.data.state).toBe(CrossState.NoPrint);
    expect(v.data.noPrintReason.__option === 'Some' ? v.data.noPrintReason.value : null).toBe(NoPrintReason.BelowMinimumVolume);
    const before = await w.h.balanceOf(a.owner.address, w.quoteMint);
    await w.claimAll(v, [a]);
    expect(await w.h.balanceOf(a.owner.address, w.quoteMint)).toBe(before + a.escrow);
  });

  it('an extension nobody draws does not strand the cross: it clears as it stands after the grace period', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, minMatched: 900_000_000n, rules: { ending: { extensionMinSecs: 60, extensionMaxSecs: 60 } } });
    at(w, 10n);
    await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, 1_500_000n, 100_000_000n);
    w.h.setTime(cross.data.closeTs + 1n);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    const clear = (await w.settleIxs(w.view(cross.address))).at(-1)!;
    expect(await w.h.fail([clear], w.admin)).toMatch(/ExtensionPending/);
    w.h.setTime(cross.data.revealEndTs + 3n * 24n * 3600n + 1n);
    await w.h.send([clear], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.NoPrint);
  });
});

describe('coarse indicative view', () => {
  it('shows a banded price and a three-way imbalance, never the fine figures', () => {
    const v = coarseIndicative({ minPrice: 1_000_000n, tick: 100_000n, ticks: 21, price: 1_537_000n, demand: 130n, supply: 100n });
    expect(v.price! % 250_000n).toBe(0n);
    expect(v.imbalance).toBe('demand-heavy');
    expect(coarseIndicative({ minPrice: 0n, tick: 1n, ticks: 11, price: null, demand: 100n, supply: 110n }).imbalance).toBe('balanced');
  });
});
