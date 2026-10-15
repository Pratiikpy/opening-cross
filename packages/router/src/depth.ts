// Per-cross depth and price impact (PRODUCT_FEATURES X8, ADR-0922).
//
// A cross has no continuous order book and no marginal price, so "depth" and "slippage" mean something specific here:
//
//  * depth is the resting quantity at each price on the grid, cumulated the way a depth chart does: everything bid at or above a price on one
//    side, everything offered at or below it on the other. It exists only while the book is open to read (an open-disclosure cross in its call
//    period). A sealed book is hidden by design, and this module says so rather than inventing a shape;
//  * price impact is what an extra order of a given size does to the clearing price. The clearing rule is run on the live book without the order
//    and again with it (a market order: the buyer's limit is the top of the grid, the seller's the bottom), and the difference is the impact. The
//    order is added last, so it is the one that waits behind equal-priced orders, exactly as `quoteCross` adds it.
//
// Nothing is sampled or modelled: the clearing rule is the verifier package's reference implementation, the one the on-chain program is tested against.
import type { Address } from '@solana/kit';
import { CROSS_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, CrossState, Disclosure, type Cross, getCrossDecoder } from '@opening-cross/cross-core-client';
import { type RefOrder, referenceClear, referenceFills } from '@opening-cross/verifier';
import { type AccountReader, loadBook } from './index.js';

export const CROSS_DEPTH_SCHEMA = 'opening-cross/cross-depth/v1';

export type DepthLevel = {
  price: bigint;
  buyQuantity: bigint;
  sellQuantity: bigint;
  buyOrders: number;
  sellOrders: number;
  /** Everything bid at this price or higher: what a seller at this price could sell into. */
  cumulativeBuy: bigint;
  /** Everything offered at this price or lower: what a buyer at this price could buy. */
  cumulativeSell: bigint;
};

export type ImpactRow = {
  side: 'buy' | 'sell';
  /** Base atoms in the added order. */
  size: bigint;
  /** Whether the cross would print with this order on the book. */
  prints: boolean;
  /** The clearing price with the order, in cross price units. */
  price: bigint | null;
  /** The order's own fill, base atoms. */
  fill: bigint;
  /** Clearing price with the order against without it, in basis points, signed from the order's point of view: positive means the order moves the price against itself. Null when there is no price on one side of the comparison. */
  impactBps: bigint | null;
};

export type CrossDepth =
  | { available: false; cross: Address; reason: string }
  | {
      available: true;
      cross: Address;
      state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
      disclosure: 'open' | 'sealed';
      priceScale: bigint;
      tick: bigint;
      minPrice: bigint;
      ticks: number;
      openTs: bigint;
      closeTs: bigint;
      feeBps: number;
      /** False when the book cannot be read: the cross is sealed, or no longer accepting orders. */
      bookVisible: boolean;
      hiddenBecause: string | null;
      totals: { buyQuantity: bigint; sellQuantity: bigint; buyOrders: number; sellOrders: number } | null;
      levels: DepthLevel[] | null;
      /** Where the cross would clear on the book as it stands, with no order added. Null when the book is hidden. */
      baseline: { prints: boolean; price: bigint | null; matched: bigint } | null;
      impact: ImpactRow[];
      /** For a cross that has cleared: the outcome on chain. */
      settled: { price: bigint | null; matched: bigint } | null;
    };

/** Fractions of the baseline volume (or of the resting book) the default price-impact sizes are, in percent. */
export const DEFAULT_IMPACT_PERCENT = [1n, 2n, 5n, 10n, 25n, 50n, 100n] as const;

/**
 * The depth of one cross and the price impact of orders of set sizes on each side.
 *
 * `sizes` are base atoms. When omitted they are `DEFAULT_IMPACT_PERCENT` of the baseline matched volume, or of the larger side of the resting
 * book when nothing clears yet; when the book is empty there are no sizes to choose and the impact list is empty.
 */
export async function crossDepth(read: AccountReader, cross: Address, opts: { sizes?: bigint[]; maxSizes?: number } = {}): Promise<CrossDepth> {
  const acct = await read(cross);
  if (!acct) return { available: false, cross, reason: 'cross not found' };
  const isCross = acct.owner === CROSS_CORE_PROGRAM_ADDRESS && acct.data.length >= 8 && (CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b);
  if (!isCross) return { available: false, cross, reason: 'not an Opening Cross account' };
  const c: Cross = getCrossDecoder().decode(acct.data);
  const state = (['Live', 'Cleared', 'NoPrint', 'Finalized'] as const)[c.state] ?? 'Live';
  const base = {
    available: true as const,
    cross,
    state,
    disclosure: c.disclosure === Disclosure.Sealed ? ('sealed' as const) : ('open' as const),
    priceScale: c.priceScale,
    tick: c.tick,
    minPrice: c.minPrice,
    ticks: c.ticks,
    openTs: c.openTs,
    closeTs: c.closeTs,
    feeBps: c.protocolFeeBps + c.integratorFeeBps,
    settled: c.clearing.__option === 'Some' ? { price: c.clearing.value.price, matched: c.clearing.value.matched } : state === 'NoPrint' ? { price: null, matched: 0n } : null,
  };
  const hidden = (why: string): CrossDepth => ({ ...base, bookVisible: false, hiddenBecause: why, totals: null, levels: null, baseline: null, impact: [] });
  if (c.state !== CrossState.Live) return hidden('the cross is no longer accepting orders, so there is no book to add to');
  if (c.disclosure === Disclosure.Sealed) return hidden('the book is sealed until reveal; sealed bids are hidden by design');
  const book = await loadBook(read, cross, c);
  if (typeof book === 'string') return hidden(book);

  const grid = { min: c.minPrice, tick: c.tick, ticks: c.ticks };
  const referencePrice = c.referencePrice.__option === 'Some' ? c.referencePrice.value : null;
  const orders: RefOrder[] = [];
  const levels: DepthLevel[] = [];
  const totals = { buyQuantity: 0n, sellQuantity: 0n, buyOrders: 0, sellOrders: 0 };
  for (let i = 0; i < c.ticks; i++) {
    const price = c.minPrice + BigInt(i) * c.tick;
    if (book.buy[i]! > 0n) orders.push({ side: 'buy', price, quantity: book.buy[i]! });
    if (book.sell[i]! > 0n) orders.push({ side: 'sell', price, quantity: book.sell[i]! });
    totals.buyQuantity += book.buy[i]!;
    totals.sellQuantity += book.sell[i]!;
    totals.buyOrders += book.buyOrders[i]!;
    totals.sellOrders += book.sellOrders[i]!;
  }
  // Cumulate: bids from the top of the grid down, offers from the bottom up.
  const cumBuy = new Array<bigint>(c.ticks);
  const cumSell = new Array<bigint>(c.ticks);
  let run = 0n;
  for (let i = c.ticks - 1; i >= 0; i--) cumBuy[i] = run += book.buy[i]!;
  run = 0n;
  for (let i = 0; i < c.ticks; i++) cumSell[i] = run += book.sell[i]!;
  for (let i = 0; i < c.ticks; i++) {
    if (book.buy[i]! === 0n && book.sell[i]! === 0n) continue;
    levels.push({ price: c.minPrice + BigInt(i) * c.tick, buyQuantity: book.buy[i]!, sellQuantity: book.sell[i]!, buyOrders: book.buyOrders[i]!, sellOrders: book.sellOrders[i]!, cumulativeBuy: cumBuy[i]!, cumulativeSell: cumSell[i]! });
  }

  const r0 = referenceClear(orders, grid, referencePrice);
  const baseline = { prints: r0 !== null, price: r0?.price ?? null, matched: r0 ? r0.matched : 0n };
  const scale = baseline.matched > 0n ? baseline.matched : totals.buyQuantity > totals.sellQuantity ? totals.buyQuantity : totals.sellQuantity;
  let sizes = opts.sizes;
  if (!sizes) sizes = scale > 0n ? [...new Set(DEFAULT_IMPACT_PERCENT.map((p) => (scale * p + 99n) / 100n))].filter((s) => s > 0n) : [];
  if (opts.maxSizes !== undefined) sizes = sizes.slice(0, opts.maxSizes);

  const maxPrice = c.minPrice + BigInt(c.ticks - 1) * c.tick;
  const impact: ImpactRow[] = [];
  for (const size of sizes) {
    for (const side of ['buy', 'sell'] as const) {
      const mine: RefOrder = { side, price: side === 'buy' ? maxPrice : c.minPrice, quantity: size };
      const all = [...orders, mine];
      const r = referenceClear(all, grid, referencePrice);
      if (!r) {
        impact.push({ side, size, prints: false, price: null, fill: 0n, impactBps: null });
        continue;
      }
      const fill = referenceFills(all, r).at(-1)!;
      let impactBps: bigint | null = null;
      if (baseline.price !== null && baseline.price > 0n) {
        const move = side === 'buy' ? r.price - baseline.price : baseline.price - r.price;
        // Rounded away from zero, so a small adverse move is never shown as none.
        impactBps = move >= 0n ? (move * 10_000n + baseline.price - 1n) / baseline.price : -((-move * 10_000n + baseline.price - 1n) / baseline.price);
      }
      impact.push({ side, size, prints: true, price: r.price, fill, impactBps });
    }
  }
  return { ...base, bookVisible: true, hiddenBecause: null, totals, levels, baseline, impact };
}
