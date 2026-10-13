// Re-clearing a settled cross with orders added, by the independent implementation of the clearing rule (packages/verifier),
// the same one that checks every cross on chain. The guards are the two a book can decide on its own: the minimum matched
// volume and the maximum imbalance. A no-print caused by an oracle, a halt or a corporate action depends on state outside the
// book and cannot be replayed; the replay says so instead of guessing.
import { referenceClear, referenceFills } from '@opening-cross/verifier';
import type { BaselineCheck, CrossReplay, HistoricalCross, Order, OrderResult, Outcome, Strategy } from './types.js';

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

const feeOf = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n;

/** Clears `book` plus `extra`. `fills` has one entry per order of `[...book, ...extra]`. */
export function clearBook(c: HistoricalCross, extra: readonly Order[] = []): { outcome: Outcome; fills: bigint[]; all: Order[] } {
  const all = [...c.book, ...extra];
  const grid = { min: c.grid.min, tick: c.grid.tick, ticks: c.grid.ticks };
  const r = referenceClear(all as never, grid, c.referencePrice);
  if (!r) return { outcome: { printed: false, reason: 'NoCross' }, fills: all.map(() => 0n), all };
  let d = 0n;
  let s = 0n;
  for (const o of all) {
    if (o.side === 'buy' && o.price >= r.price) d += o.quantity;
    if (o.side === 'sell' && o.price <= r.price) s += o.quantity;
  }
  const imbalance = d > s ? d - s : s - d;
  if (r.matched < c.minMatched) return { outcome: { printed: false, reason: 'BelowMinimumVolume' }, fills: all.map(() => 0n), all };
  if (c.maxImbalanceBps !== null && imbalance * 10_000n > c.maxImbalanceBps * r.matched) return { outcome: { printed: false, reason: 'ImbalanceTooHigh' }, fills: all.map(() => 0n), all };
  return { outcome: { printed: true, price: r.price, matched: r.matched, rationed: r.rationed }, fills: referenceFills(all as never, r), all };
}

const same = (a: Outcome, b: Outcome): boolean => (a.printed && b.printed ? a.price === b.price && a.matched === b.matched && a.rationed === b.rationed : !a.printed && !b.printed && a.reason === b.reason);

/**
 * Whether the replay of the cross as it was reproduces the program's record. `external` means the program's verdict rested on
 * state that is not in the book (an oracle, a halt, a corporate action, an expired settlement), so the book alone cannot confirm
 * or refute it; it is reported, never counted as a match.
 */
export function checkBaseline(c: HistoricalCross, baseline: Outcome): BaselineCheck {
  const rec = c.recorded;
  if (!rec) return 'external';
  if (!rec.printed && EXTERNAL.includes(rec.reason)) return 'external';
  return same(rec, baseline) ? 'match' : 'mismatch';
}

const EXTERNAL = ['OracleDivergence', 'OracleUnavailable', 'Halted', 'CorporateAction', 'IssuerPaused', 'SettlementExpired'];

function onGrid(c: HistoricalCross, o: Order): string | null {
  if (o.quantity <= 0n) return 'an order needs a positive quantity';
  if (o.price < c.grid.min || (o.price - c.grid.min) % c.grid.tick !== 0n || (o.price - c.grid.min) / c.grid.tick >= BigInt(c.grid.ticks)) return `price ${o.price} is not on this cross's grid`;
  if (o.side === 'sell' && c.supplyMode !== 'escrow') return 'this cross mints its supply and takes no sell orders';
  return null;
}

/** Replays one cross with a strategy. */
export function replayCross(c: HistoricalCross, strategy: Strategy | null, reference: bigint | null): CrossReplay {
  const base = clearBook(c);
  const out = { cross: c.address, closeTs: c.closeTs, baselineCheck: checkBaseline(c, base.outcome), baseline: base.outcome };
  if (!strategy) return { ...out, participated: false, withStrategy: null, orders: [], impactTicks: null, note: null };
  if (c.disclosure === 'sealed') return { ...out, participated: false, withStrategy: null, orders: [], impactTicks: null, note: 'sealed cross: the strategy would have faced a hidden book' };
  const wanted = strategy.orders({ cross: c, book: c.book, reference });
  if (wanted.length === 0) return { ...out, participated: false, withStrategy: null, orders: [], impactTicks: null, note: 'the strategy sat this cross out' };
  for (const o of wanted) {
    const bad = onGrid(c, o);
    if (bad) throw new ReplayError(`strategy "${strategy.name}" on ${c.address}: ${bad}`);
  }
  const mine = clearBook(c, wanted);
  const results: OrderResult[] = wanted.map((order, i) => {
    const filled = mine.fills[c.book.length + i]!;
    const price = mine.outcome.printed ? mine.outcome.price : 0n;
    const gross = order.side === 'buy' ? (filled * price + c.grid.priceScale - 1n) / c.grid.priceScale : (filled * price) / c.grid.priceScale;
    const feePaid = order.side === 'sell' && c.supplyMode === 'escrow' ? feeOf(gross, c.feeBps) : 0n;
    return { order, filled, quote: order.side === 'buy' ? gross : gross - feePaid, avgPrice: filled === 0n ? null : price, feePaid };
  });
  const impact = base.outcome.printed && mine.outcome.printed ? Number((mine.outcome.price - base.outcome.price) / c.grid.tick) : null;
  return { ...out, participated: true, withStrategy: mine.outcome, orders: results, impactTicks: impact, note: null };
}

