// What the bot quotes, as pure functions of a reference price, a budget and the cross's grid.
//
// The bot is the company's own market maker (PRODUCT_FEATURES X6, Y7). It trades from its own budget, never from the
// rebate pool, and its wallet is listed in OWN_WALLETS so the external-flow scorecard leaves it out. Everything it
// does is an ordinary limit order from escrow: it can lose money, it cannot move a price except by being one more
// order in a uniform-price book, and it never knows other orders in a sealed cross.
import { type Curve, type Grid, type Ladder, ladder, requiredEscrow, selfCross } from '@opening-cross/liquidity';

export type Strategy = {
  /** Distance of the first level from the reference, in basis points, on each side. */
  readonly halfSpreadBps: number;
  /** Number of price levels per side, 1 to 8. */
  readonly levels: number;
  /** Extra distance of each further level, in basis points. */
  readonly stepBps: number;
  /** Most quote atoms escrowed in one cross. */
  readonly quoteBudget: bigint;
  /** Most base atoms escrowed in one cross. */
  readonly baseBudget: bigint;
  /** A cross that closes sooner than this is left alone: a transaction may not land in time. */
  readonly minSecondsLeft: number;
};

export class StrategyError extends Error {
  override readonly name = 'StrategyError';
}

export function validateStrategy(s: Strategy): void {
  if (!Number.isInteger(s.halfSpreadBps) || s.halfSpreadBps < 1) throw new StrategyError('halfSpreadBps must be a positive integer');
  if (!Number.isInteger(s.levels) || s.levels < 1 || s.levels > 8) throw new StrategyError('levels must be an integer from 1 to 8');
  if (!Number.isInteger(s.stepBps) || s.stepBps < 0) throw new StrategyError('stepBps must be a non-negative integer');
  if (s.halfSpreadBps + (s.levels - 1) * s.stepBps >= 10_000) throw new StrategyError('the outermost level would be at or below a zero price');
  if (s.quoteBudget < 0n || s.baseBudget < 0n) throw new StrategyError('budgets cannot be negative');
  if (!Number.isInteger(s.minSecondsLeft) || s.minSecondsLeft < 0) throw new StrategyError('minSecondsLeft must be a non-negative integer');
}

export type QuotePlan =
  | { readonly kind: 'quote'; readonly ladder: Ladder; readonly escrow: { quote: bigint; base: bigint }; readonly notes: readonly string[] }
  | { readonly kind: 'skip'; readonly reason: string };

/**
 * The ladder to place around `reference` (price units of the cross). Each side spends at most its budget and at most what
 * the wallet holds. `sells` is false in a cross that mints its own supply: cross_core accepts no sell order there.
 */
export function buildQuote(reference: bigint, s: Strategy, grid: Grid, inventory: { quote: bigint; base: bigint }, sells: boolean): QuotePlan {
  validateStrategy(s);
  if (reference <= 0n) return { kind: 'skip', reason: 'the reference price is not positive' };
  const spendQuote = inventory.quote < s.quoteBudget ? inventory.quote : s.quoteBudget;
  const spendBase = sells ? (inventory.base < s.baseBudget ? inventory.base : s.baseBudget) : 0n;
  const buy: { price: bigint; quantity: bigint }[] = [];
  const sell: { price: bigint; quantity: bigint }[] = [];
  const levels = BigInt(s.levels);
  for (let i = 0; i < s.levels; i++) {
    const d = BigInt(s.halfSpreadBps + i * s.stepBps);
    const bid = (reference * (10_000n - d)) / 10_000n;
    const ask = (reference * (10_000n + d) + 9_999n) / 10_000n;
    if (bid > 0n) {
      const quantity = (spendQuote / levels * grid.priceScale) / bid;
      if (quantity > 0n) buy.push({ price: bid, quantity });
    }
    const quantity = spendBase / levels;
    if (quantity > 0n) sell.push({ price: ask, quantity });
  }
  const l = ladder({ buy, sell }, grid);
  const notes = [...l.adjusted.map((a) => `snapped to the grid: ${a}`), ...l.dropped.map((x) => `dropped: ${x.reason}`)];
  if (l.buy.length === 0 && l.sell.length === 0) return { kind: 'skip', reason: 'nothing to place: the budget or inventory is too small, or the reference is outside the grid' };
  const crossed = selfCross(l);
  if (crossed) return { kind: 'skip', reason: `own bid ${crossed.bid} would meet own ask ${crossed.ask}` };
  const escrow = requiredEscrow(l, grid.priceScale);
  if (escrow.quote > inventory.quote || escrow.base > inventory.base) return { kind: 'skip', reason: 'the ladder needs more than the wallet holds' };
  if (l.buy.length === 0) notes.push('no bids: the quote budget or balance is too small');
  if (l.sell.length === 0) notes.push(sells ? 'no asks: the base budget or balance is too small' : 'no asks: this cross mints its supply and accepts no sells');
  return { kind: 'quote', ladder: l, escrow, notes };
}

export type ReferenceSource = 'configured' | 'last-print' | 'indicative';
export type Reference = { readonly price: bigint; readonly source: ReferenceSource; readonly detail: string };

export type ReferenceInputs = {
  /** The operator's own view of fair value for this base mint, in cross price units, if one is configured. */
  readonly configured: bigint | null;
  /** The clearing price of the latest finalized cross of the same pair on this cluster, with its address. */
  readonly lastPrint: { readonly price: bigint; readonly cross: string } | null;
  /** The indicative price of the cross's own book, when other orders already cross. */
  readonly indicative: bigint | null;
};

/**
 * Where the bot gets a price to quote around, in this order: the operator's configured fair value, the last printed price
 * of the same pair, the indicative price of the book. The bot never invents one: with none of the three it does not quote.
 * A configured value comes first because it is the operator's decision; the other two are what the market last said.
 */
export function chooseReference(i: ReferenceInputs): Reference | null {
  if (i.configured !== null && i.configured > 0n) return { price: i.configured, source: 'configured', detail: 'fair value set by the operator' };
  if (i.lastPrint) return { price: i.lastPrint.price, source: 'last-print', detail: `cleared at this price in ${i.lastPrint.cross}` };
  if (i.indicative !== null && i.indicative > 0n) return { price: i.indicative, source: 'indicative', detail: 'the book already crosses at this price' };
  return null;
}
