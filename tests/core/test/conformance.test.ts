// The deployed program against the conformance vectors (ROADMAP D5). Every vector the program
// can represent is run as a real cross on LiteSVM — orders placed, book cleared, every order
// claimed — and the on-chain outcome and each order's claimed fill must equal the vector.
// Vectors outside the program's limits (more than MAX_TICKS grid prices, or a price level whose
// total does not fit the book's u64 counters) are listed, never silently dropped.
import { describe, expect, it } from 'vitest';
import { CrossState, NoPrintReason, OrderSide, orderAddress } from '@opening-cross/sdk';
import { decodeLogs } from '@opening-cross/indexer';
import { type ConformanceCase, loadVectors } from '@opening-cross/verifier';
import { World, SCALE } from '../src/world.js';
import { T0 } from '../src/harness.js';

const MAX_TICKS = 256;
const U64 = (1n << 64n) - 1n;
const REASONS: Record<number, string> = { [NoPrintReason.NoCross]: 'NoCross', [NoPrintReason.BelowMinimumVolume]: 'BelowMinimumVolume', [NoPrintReason.ImbalanceTooHigh]: 'ImbalanceTooHigh' };

function unsupported(c: ConformanceCase): string | null {
  if (c.grid.ticks > MAX_TICKS) return `${c.grid.ticks} ticks exceeds MAX_TICKS`;
  const levels = new Map<string, bigint>();
  let quote = 0n;
  for (const o of c.orders) {
    const k = `${o.side}:${o.price}`;
    levels.set(k, (levels.get(k) ?? 0n) + BigInt(o.quantity));
    if (o.side === 'buy') quote += (BigInt(o.quantity) * BigInt(o.price) + SCALE - 1n) / SCALE;
  }
  if ([...levels.values()].some((v) => v > U64)) return 'a price level total exceeds u64';
  if (quote > U64 / 2n) return 'buyer escrow exceeds the quote mint supply';
  return null;
}

describe('cross_core against conformance v1', () => {
  it('reproduces every representable vector on chain, fills included', async () => {
    const vectors = loadVectors();
    const skipped = vectors.cases.flatMap((c) => { const why = unsupported(c); return why ? [`${c.name}: ${why}`] : []; });
    const cases = vectors.cases.filter((c) => !unsupported(c));
    const w = await World.create();
    const mismatches: string[] = [];
    for (const c of cases) {
      // Fresh mints per case: supplies summed across 500 books exceed u64.
      await w.freshMints();
      w.h.setTime(T0);
      const cross = await w.newCross({
        minPrice: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks,
        reference: c.reference === null ? null : BigInt(c.reference),
        minMatched: BigInt(c.guards.minMatched), maxImbalanceBps: c.guards.maxImbalanceBps,
        maxOrders: Math.max(1, c.orders.length), shards: 1,
      });
      const need = { quote: 0n, base: 0n };
      for (const o of c.orders) {
        if (o.side === 'buy') need.quote += (BigInt(o.quantity) * BigInt(o.price) + SCALE - 1n) / SCALE;
        else need.base += BigInt(o.quantity);
      }
      const buyer = await w.trader(need.quote);
      const seller = await w.trader(0n, need.base);
      const placed = [];
      for (const o of c.orders) placed.push(await w.place(cross, o.side === 'buy' ? buyer : seller, o.side === 'buy' ? OrderSide.Buy : OrderSide.Sell, BigInt(o.price), BigInt(o.quantity)));
      const from = w.h.landed.length;
      const settled = await w.settle(cross);
      await w.claimAll(settled, placed);
      const fills = new Map<number, bigint>();
      // Each claim names its order account; map it back to the vector's order.
      const byAddress = new Map<string, number>();
      for (const [i, p] of placed.entries()) byAddress.set(await orderAddress(cross.address, p.owner.address, p.nonce), i);
      for (const tx of w.h.landed.slice(from)) for (const e of decodeLogs(tx.logs)) if (e.name === 'OrderClaimed' && e.data.cross === cross.address) fills.set(byAddress.get(e.data.order)!, e.data.fill);

      const d = settled.data;
      const got = d.state === CrossState.Cleared && d.clearing.__option === 'Some'
        ? JSON.stringify([true, d.clearing.value.price.toString(), d.clearing.value.matched.toString(), ['none', 'buy', 'sell'][d.clearing.value.rationed], placed.map((_, i) => (fills.get(i) ?? -1n).toString())])
        : JSON.stringify([false, d.noPrintReason.__option === 'Some' ? REASONS[d.noPrintReason.value] : null]);
      const e = c.expect;
      const want = e.printed ? JSON.stringify([true, e.price, e.matched, e.rationed, e.fills]) : JSON.stringify([false, e.noPrintReason]);
      if (got !== want) mismatches.push(`${c.name}\n  chain:  ${got}\n  vector: ${want}`);
    }
    console.log(`conformance on chain: ${cases.length} run, ${mismatches.length} mismatches, ${skipped.length} outside program limits:\n  ${skipped.join('\n  ')}`);
    expect(mismatches).toEqual([]);
    expect(cases.length).toBeGreaterThan(450);
  }, 900_000);
});
