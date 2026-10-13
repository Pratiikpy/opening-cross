// The launch simulator (ROADMAP A8): what a cross would do with the issuer's supply schedule against a demand the issuer supplies,
// or a demand read from somewhere real (a finished cross's book, the draft's soft commits). It is the clearing rule of ADR-0003
// and the print guards and fees of the program, written over integers, so a result is what the chain would do with that book.
// It is NOT a forecast: nothing here says how much demand will arrive, and the page labels every result "Model estimate".
//
// Differences from the program that the caller must know:
//  - Fees are computed on filled notional with the formulas of cross_core (ADR-0010). The real total is the sum of per-order
//    roundings; the figure here is within a few atoms of it.
//  - The oracle guard is not simulated: its verdict depends on a Pyth update that is not known in advance.
export type SimGrid = { minPrice: bigint; tick: bigint; ticks: number; priceScale: bigint; baseDecimals: number; quoteDecimals: number };
export type Step = { price: bigint; quantity: bigint };
export type Side = 'buy' | 'sell';

export type SimInput = {
  grid: SimGrid;
  /** Sell side: the mint-mode supply schedule, or the escrow-mode quantities offered. Prices must be on the grid. */
  supply: readonly Step[];
  /** Buy side: bids as (limit price, quantity). Prices off the grid are ignored and counted in `ignoredDemand`. */
  demand: readonly Step[];
  supplyMode: 'mint' | 'escrow';
  /** Base atoms already minted before the cross. In mint mode the cross adds what it sells to this; in escrow mode it is the whole supply. */
  existingSupply: bigint;
  /** Minimum volume guard in base atoms (0 = none). */
  minMatched: bigint;
  /** Maximum imbalance guard in basis points of the matched quantity, or null. */
  maxImbalanceBps: number | null;
  /** Fee basis points the cross would snapshot. */
  protocolBps: number;
  integratorBps: number;
};

export type NoPrintReason = 'NoCross' | 'BelowMinimumVolume' | 'ImbalanceTooHigh';

export type Printed = {
  printed: true;
  price: bigint;
  matched: bigint;
  rationed: Side | null;
  /** Quote atoms buyers pay for the matched quantity at the clearing price (rounded up, as the program charges). */
  raise: bigint;
  fees: bigint;
  /** Quote atoms the issuer keeps from the sale: raise less fees. */
  net: bigint;
  /** Base atoms in existence after the cross: fixed forever once a minting cross finalizes. */
  totalSupplyAfter: bigint;
  /** Matched share of the total supply after the cross, in basis points (floor). */
  floatBps: bigint;
  /** Fully diluted value at the clearing price, in quote atoms (floor). */
  fdv: bigint;
  /** Base atoms offered at or below the clearing price that did not trade. */
  unsold: bigint;
  /** Demand at or above the clearing price over supply at or below it, in basis points (10_000 = exactly met). */
  demandOverSupplyBps: bigint;
  imbalance: bigint;
};

export type NotPrinted = { printed: false; reason: NoPrintReason; wouldClearAt: { price: bigint; matched: bigint } | null };
export type SimResult = Printed | NotPrinted;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function tickOf(price: bigint, g: SimGrid): number | null {
  if (g.tick <= 0n || price < g.minPrice || (price - g.minPrice) % g.tick !== 0n) return null;
  const i = (price - g.minPrice) / g.tick;
  return i < BigInt(g.ticks) ? Number(i) : null;
}

/** Buy and sell aggregates per grid tick. Steps off the grid are dropped and their quantity is returned. */
export function aggregate(g: SimGrid, supply: readonly Step[], demand: readonly Step[]): { buy: bigint[]; sell: bigint[]; ignoredDemand: bigint; ignoredSupply: bigint } {
  const buy = new Array<bigint>(g.ticks).fill(0n);
  const sell = new Array<bigint>(g.ticks).fill(0n);
  let ignoredDemand = 0n;
  let ignoredSupply = 0n;
  for (const s of supply) {
    const i = tickOf(s.price, g);
    if (i === null) ignoredSupply += s.quantity;
    else sell[i]! += s.quantity;
  }
  for (const d of demand) {
    const i = tickOf(d.price, g);
    if (i === null) ignoredDemand += d.quantity;
    else buy[i]! += d.quantity;
  }
  return { buy, sell, ignoredDemand, ignoredSupply };
}

type Found = { i: number; matched: bigint; imbalance: bigint; d: bigint; s: bigint };

/** ADR-0003: the price that trades the most, then leaves the smallest imbalance, then the lowest price. Exhaustive over the grid. */
function findPrice(buy: bigint[], sell: bigint[]): Found | null {
  const n = buy.length;
  const demandFrom = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) demandFrom[i] = demandFrom[i + 1]! + buy[i]!;
  let supplyTo = 0n;
  let best: Found | null = null;
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
  return best;
}

export function simulate(inp: SimInput): SimResult {
  const g = inp.grid;
  const { buy, sell } = aggregate(g, inp.supply, inp.demand);
  const f = findPrice(buy, sell);
  if (!f) return { printed: false, reason: 'NoCross', wouldClearAt: null };
  const price = g.minPrice + BigInt(f.i) * g.tick;
  const would = { price, matched: f.matched };
  // §7.7: minimum volume first, then maximum imbalance. Both strict, both without division.
  if (f.matched < inp.minMatched) return { printed: false, reason: 'BelowMinimumVolume', wouldClearAt: would };
  if (inp.maxImbalanceBps !== null && f.imbalance * 10_000n > BigInt(inp.maxImbalanceBps) * f.matched) return { printed: false, reason: 'ImbalanceTooHigh', wouldClearAt: would };

  const raise = ceilDiv(f.matched * price, g.priceScale);
  const totalBps = BigInt(Math.min(inp.protocolBps + inp.integratorBps, 65_535));
  const fees = (raise * totalBps) / 10_000n;
  const totalSupplyAfter = inp.supplyMode === 'mint' ? inp.existingSupply + f.matched : inp.existingSupply;
  return {
    printed: true,
    price,
    matched: f.matched,
    rationed: f.d > f.s ? 'buy' : f.s > f.d ? 'sell' : null,
    raise,
    fees,
    net: raise - fees,
    totalSupplyAfter,
    floatBps: totalSupplyAfter === 0n ? 0n : (f.matched * 10_000n) / totalSupplyAfter,
    fdv: (price * totalSupplyAfter) / g.priceScale,
    unsold: f.s - f.matched,
    demandOverSupplyBps: f.s === 0n ? 0n : (f.d * 10_000n) / f.s,
    imbalance: f.imbalance,
  };
}

/** Demand scaled by `num/den` (floor): the low, base and high scenarios of the simulator page. */
export function scaleDemand(demand: readonly Step[], num: bigint, den: bigint): Step[] {
  return demand.map((d) => ({ price: d.price, quantity: (d.quantity * num) / den }));
}

export const SCENARIOS = [
  { id: 'low', label: 'Half the demand', num: 1n, den: 2n },
  { id: 'base', label: 'The demand you entered', num: 1n, den: 1n },
  { id: 'high', label: 'Double the demand', num: 2n, den: 1n },
] as const;

export type Scenario = { id: (typeof SCENARIOS)[number]['id']; label: string; result: SimResult };

/** The same book at half, once and twice the demand. These are scenarios, not a confidence interval. */
export function scenarios(inp: SimInput): Scenario[] {
  return SCENARIOS.map((s) => ({ id: s.id, label: s.label, result: simulate({ ...inp, demand: scaleDemand(inp.demand, s.num, s.den) }) }));
}

/**
 * What a buyer with this limit price gets when the book clears as `r`: nothing below the clearing price, everything above it, and a
 * share at it when buyers are rationed (ADR-0003: buys floor). `quantity` is the order's size; `atPriceBuy` is all buy quantity at
 * the clearing price, `betterBuy` the buy quantity strictly above it.
 */
export function buyerFill(r: Printed, limit: bigint, quantity: bigint, atPriceBuy: bigint, betterBuy: bigint): bigint {
  if (limit < r.price) return 0n;
  if (limit > r.price || r.rationed !== 'buy') return quantity;
  const room = r.matched - betterBuy;
  if (atPriceBuy === 0n || room <= 0n) return 0n;
  const share = (quantity * room) / atPriceBuy;
  return share > quantity ? quantity : share;
}

/** Buy quantity at the clearing price and strictly above it, for `buyerFill`. */
export function buyAround(inp: SimInput, price: bigint): { atPrice: bigint; better: bigint } {
  let atPrice = 0n;
  let better = 0n;
  for (const d of inp.demand) {
    if (tickOf(d.price, inp.grid) === null) continue;
    if (d.price === price) atPrice += d.quantity;
    else if (d.price > price) better += d.quantity;
  }
  return { atPrice, better };
}

export type LadderRow = { index: number; price: bigint; /** Buy quantity at or above this price. */ demand: bigint; /** Sell quantity at or below this price. */ supply: bigint; clearing: boolean };

/**
 * The rows worth drawing: every price where an order sits, the clearing price, and the price on either side of the clearing price,
 * lowest first. Cumulative demand and supply are what the rule compares at each price.
 */
export function ladder(inp: SimInput, clearingPrice: bigint | null): LadderRow[] {
  const g = inp.grid;
  const { buy, sell } = aggregate(g, inp.supply, inp.demand);
  const rows: LadderRow[] = [];
  let supplyTo = 0n;
  const demandFrom = new Array<bigint>(g.ticks + 1).fill(0n);
  for (let i = g.ticks - 1; i >= 0; i--) demandFrom[i] = demandFrom[i + 1]! + buy[i]!;
  const clearingIndex = clearingPrice === null ? -1 : Number((clearingPrice - g.minPrice) / g.tick);
  for (let i = 0; i < g.ticks; i++) {
    supplyTo += sell[i]!;
    const active = buy[i]! > 0n || sell[i]! > 0n || Math.abs(i - clearingIndex) <= 1;
    if (active && (clearingIndex >= 0 || buy[i]! > 0n || sell[i]! > 0n)) rows.push({ index: i, price: g.minPrice + BigInt(i) * g.tick, demand: demandFrom[i]!, supply: supplyTo, clearing: i === clearingIndex });
  }
  return rows;
}

/**
 * What one more bid of `quantity` at `limit` would get if it joined the book: the book is cleared again with the bid in it, so the bid can
 * move the price and takes its share of any rationing, exactly as it would on chain.
 */
export function bidderFill(inp: SimInput, limit: bigint, quantity: bigint): { result: SimResult; fill: bigint } {
  const withBid: SimInput = { ...inp, demand: [...inp.demand, { price: limit, quantity }] };
  const result = simulate(withBid);
  if (!result.printed) return { result, fill: 0n };
  const { atPrice, better } = buyAround(withBid, result.price);
  return { result, fill: buyerFill(result, limit, quantity, atPrice, better) };
}
