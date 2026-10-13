// A read-only copy of the clearing rule (ADR-0003) over the book the API serves, used to answer "what would
// the price be if my order were added". It is exhaustive over the grid, like the verifier's reference
// implementation (packages/verifier/src/reference.ts), but works from per-price totals instead of orders.
// The page never trusts it blindly: `simulateAgainstIndicative` only returns a result when this
// implementation reproduces the price the API reports for the book as it stands.
import type { BookResponse, CrossDetail } from '../../lib/types';

export type Level = BookResponse['levels'][number];
export type Grid = CrossDetail['grid'];
export type Side = 'buy' | 'sell';
export type Cleared = { price: bigint; matched: bigint; rationed: Side | null };

export type Extra = { side: Side; price: bigint; quantity: bigint };

/** Totals per grid tick, from the book's levels plus an optional extra order. Off-grid levels are ignored. */
function ticksOf(levels: readonly Level[], grid: Grid, extra?: Extra): { buy: bigint[]; sell: bigint[] } {
  const min = BigInt(grid.minPrice);
  const step = BigInt(grid.tick);
  const buy = new Array<bigint>(grid.ticks).fill(0n);
  const sell = new Array<bigint>(grid.ticks).fill(0n);
  const put = (price: bigint, side: Side, quantity: bigint) => {
    if (step === 0n || price < min || (price - min) % step !== 0n) return;
    const i = Number((price - min) / step);
    if (i >= grid.ticks) return;
    (side === 'buy' ? buy : sell)[i]! += quantity;
  };
  for (const l of levels) {
    put(BigInt(l.price), 'buy', BigInt(l.buy));
    put(BigInt(l.price), 'sell', BigInt(l.sell));
  }
  if (extra) put(extra.price, extra.side, extra.quantity);
  return { buy, sell };
}

/**
 * The price that trades the most, then leaves the smallest imbalance, then (lowest price wins) a tie.
 * Does not know the cross's reference price or print guards, which the cross detail does not carry.
 */
export function clearBook(levels: readonly Level[], grid: Grid, extra?: Extra): Cleared | null {
  const { buy, sell } = ticksOf(levels, grid, extra);
  const n = grid.ticks;
  // d[i]: buys at or above tick i; sMinus: sells strictly below tick i.
  const demandFrom = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) demandFrom[i] = demandFrom[i + 1]! + buy[i]!;
  let supplyTo = 0n; // sells at or below tick i, built up as i advances
  let best: { i: number; matched: bigint; imbalance: bigint; d: bigint; s: bigint } | null = null;
  for (let i = 0; i < n; i++) {
    const sMinus = supplyTo;
    supplyTo += sell[i]!;
    const d = demandFrom[i]!;
    const dPlus = demandFrom[i + 1]!;
    const s = supplyTo;
    const v = d < s ? d : s;
    if (v === 0n || v < dPlus || v < sMinus) continue;
    const imbalance = d > s ? d - s : s - d;
    if (!best || v > best.matched || (v === best.matched && imbalance < best.imbalance)) best = { i, matched: v, imbalance, d, s };
  }
  if (!best) return null;
  return {
    price: BigInt(grid.minPrice) + BigInt(best.i) * BigInt(grid.tick),
    matched: best.matched,
    rationed: best.d > best.s ? 'buy' : best.s > best.d ? 'sell' : null,
  };
}

/** Quantity an order of `side` at `limit` is filled for when the cross clears at `c`, with ADR-0003 rationing (buys floor, sells ceil). */
export function fillAt(levels: readonly Level[], grid: Grid, c: Cleared, order: Extra): bigint {
  const crosses = order.side === 'buy' ? order.price >= c.price : order.price <= c.price;
  if (!crosses) return 0n;
  if (order.price !== c.price || c.rationed !== order.side) return order.quantity;
  // The order sits at the clearing price on the rationed side: it shares what is left after the strictly better orders.
  const { buy, sell } = ticksOf(levels, grid, order);
  const min = BigInt(grid.minPrice);
  const step = BigInt(grid.tick);
  const at = Number((c.price - min) / step);
  const side = order.side === 'buy' ? buy : sell;
  let better = 0n;
  for (let i = 0; i < grid.ticks; i++) if (order.side === 'buy' ? i > at : i < at) better += side[i]!;
  const atPrice = side[at]!;
  const room = c.matched - better;
  if (atPrice === 0n || room <= 0n) return 0n;
  const num = order.quantity * room;
  const share = order.side === 'buy' ? num / atPrice : (num + atPrice - 1n) / atPrice;
  return share > order.quantity ? order.quantity : share;
}

/**
 * Clears the book as it stands and with `order` added. Returns null unless the rule reproduces the API's own
 * indicative price for the current book, so a disagreement (for example a reference price or print guard
 * this page cannot see) shows as "unavailable" and never as a wrong number.
 */
export function simulateAgainstIndicative(
  book: Pick<BookResponse, 'levels' | 'indicative'>,
  grid: Grid,
  order: Extra,
): { before: Cleared | null; after: Cleared | null; fill: bigint } | null {
  const before = clearBook(book.levels, grid);
  const reported = book.indicative ? BigInt(book.indicative.price) : null;
  if ((before?.price ?? null) !== reported) return null;
  if (book.indicative && before && before.matched !== BigInt(book.indicative.matched)) return null;
  const after = clearBook(book.levels, grid, order);
  return { before, after, fill: after ? fillAt(book.levels, grid, after, order) : 0n };
}
