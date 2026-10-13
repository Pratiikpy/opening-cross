// Independent TypeScript implementation of the rules added after ADR-0003: the supply cap and the
// raise, float, valuation and price-move guards (ADR-0101), allocation classes with reserved
// shares, spill-over and the class-1 lottery (ADR-0104), and the exclusion of declared insiders
// from the minimum raise (ADR-0106). Written from the ADR text rather than from clearing-core, so
// the on-chain result is checked against a second implementation. Exhaustive over every grid
// price, like the v1 reference.
import { type RefClearing, type RefOrder, ceilDiv } from './reference.js';

export interface Order2 extends RefOrder {
  /** Allocation class of a buy: 0 general, 1 identity-verified small, 2 locked, 3 priority. */
  class: number;
  /** A declared insider's buy. */
  insider: boolean;
}

export interface Rules2 {
  /** The most base the sell side delivers; null = uncapped. */
  supplyCap: bigint | null;
  minRaiseQuote: bigint;
  priceScale: bigint;
  totalSupply: bigint;
  minFloatBps: bigint;
  maxFdvX100: bigint;
  anchorPrice: bigint;
  moveBps: bigint;
  reserveBps: [bigint, bigint, bigint];
  /** Base atoms per class-1 lottery lot; 0 = no lottery. */
  lotteryUnit: bigint;
  /** Where the lottery window starts, already reduced modulo the ticket count. */
  rho: bigint;
}

export interface Clearing2 extends RefClearing {
  /** Matched volume at the clearing price after the cap. */
  demand: bigint;
  supply: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const abs = (x: bigint) => (x < 0n ? -x : x);

/** ADR-0003 with a supply cap: `S(p)` and `S⁻(p)` are `min(·, cap)`. */
export function referenceClearCapped(
  orders: RefOrder[],
  grid: { min: bigint; tick: bigint; ticks: number },
  reference: bigint | null,
  cap: bigint | null,
): Clearing2 | null {
  let best: { price: bigint; matched: bigint; imbalance: bigint; d: bigint; s: bigint } | null = null;
  for (let i = 0; i < grid.ticks; i++) {
    const p = grid.min + BigInt(i) * grid.tick;
    let d = 0n, dPlus = 0n, s = 0n, sMinus = 0n;
    for (const o of orders) {
      if (o.side === 'buy') {
        if (o.price >= p) d += o.quantity;
        if (o.price > p) dPlus += o.quantity;
      } else {
        if (o.price <= p) s += o.quantity;
        if (o.price < p) sMinus += o.quantity;
      }
    }
    if (cap !== null) {
      s = min(s, cap);
      sMinus = min(sMinus, cap);
    }
    const v = min(d, s);
    if (v === 0n || v < dPlus || v < sMinus) continue;
    const imbalance = d > s ? d - s : s - d;
    const better = (() => {
      if (!best) return true;
      if (v !== best.matched) return v > best.matched;
      if (imbalance !== best.imbalance) return imbalance < best.imbalance;
      if (reference !== null) {
        const da = abs(p - reference), db = abs(best.price - reference);
        if (da !== db) return da < db;
      }
      return p < best.price;
    })();
    if (better) best = { price: p, matched: v, imbalance, d, s };
  }
  if (!best) return null;
  return { price: best.price, matched: best.matched, rationed: best.d > best.s ? 'buy' : best.s > best.d ? 'sell' : null, demand: best.d, supply: best.s };
}

export type NoPrint2 = 'BelowMinimumVolume' | 'ImbalanceTooHigh' | 'BelowMinimumRaise' | 'FloatTooLow' | 'FdvTooHigh' | 'PriceMoved';

/** The guards in their fixed order. `counted` is the matched volume that counts (insiders left out). */
export function referenceGuards2(
  c: Clearing2,
  counted: bigint,
  rules: Rules2,
  guards: { minMatched: bigint; maxImbalanceBps: bigint | null },
): NoPrint2 | null {
  if (counted < guards.minMatched) return 'BelowMinimumVolume';
  if (guards.maxImbalanceBps !== null) {
    const imbalance = c.demand > c.supply ? c.demand - c.supply : c.supply - c.demand;
    if (imbalance * 10_000n > guards.maxImbalanceBps * c.matched) return 'ImbalanceTooHigh';
  }
  if (rules.minRaiseQuote > 0n && (counted * c.price) / rules.priceScale < rules.minRaiseQuote) return 'BelowMinimumRaise';
  if (rules.totalSupply > 0n) {
    if (rules.minFloatBps > 0n && counted * 10_000n < rules.minFloatBps * rules.totalSupply) return 'FloatTooLow';
    if (rules.maxFdvX100 > 0n && rules.totalSupply * 100n > rules.maxFdvX100 * counted) return 'FdvTooHigh';
  }
  if (rules.moveBps > 0n && rules.anchorPrice > 0n && abs(c.price - rules.anchorPrice) * 10_000n > rules.moveBps * rules.anchorPrice) return 'PriceMoved';
  return null;
}

interface Pools {
  reserved: [bigint, bigint, bigint];
  winners: bigint;
  residual: bigint;
  residualBase: bigint;
}

/** What the marginal buy orders look like at the clearing price. */
function marginal(orders: Order2[], c: Clearing2) {
  const at = orders.filter((o) => o.side === 'buy' && o.price === c.price);
  const q = at.reduce((a, o) => a + o.quantity, 0n);
  const classQty: [bigint, bigint, bigint] = [0n, 0n, 0n];
  let tickets = 0n;
  for (const o of at) {
    if (o.class >= 1 && o.class <= 3) classQty[o.class - 1]! += o.quantity;
    if (o.class === 1) tickets += 1n;
  }
  const better = orders.filter((o) => o.side === 'buy' && o.price > c.price).reduce((a, o) => a + o.quantity, 0n);
  return { q, classQty, tickets, remaining: c.matched - better };
}

function pools(orders: Order2[], c: Clearing2, rules: Rules2): Pools | null {
  if (c.rationed !== 'buy') return null;
  const m = marginal(orders, c);
  if (m.q === 0n) return null;
  const share = (i: number) => (m.remaining * rules.reserveBps[i]!) / 10_000n;
  let reserved1: bigint;
  let winners = 0n;
  if (rules.lotteryUnit > 0n) {
    const lots = share(0) / rules.lotteryUnit;
    winners = min(lots, m.tickets);
    reserved1 = winners * rules.lotteryUnit;
  } else {
    reserved1 = min(m.classQty[0], share(0));
  }
  const reserved2 = min(m.classQty[1], share(1));
  const reserved3 = min(m.classQty[2], share(2));
  const used = reserved1 + reserved2 + reserved3;
  return { reserved: [reserved1, reserved2, reserved3], winners, residual: m.remaining - used, residualBase: m.q - used };
}

const isDefaultPolicy = (r: Rules2) => r.reserveBps.every((b) => b === 0n) && r.lotteryUnit === 0n;

/** Per-order fills: ADR-0003 rationing, with the class pools of ADR-0104 at the margin of a rationed buy side. */
export function referenceFills2(orders: Order2[], c: Clearing2, rules: Rules2): bigint[] {
  const m = marginal(orders, c);
  const pl = isDefaultPolicy(rules) ? null : pools(orders, c, rules);
  const nextTicket = new Map<bigint, bigint>();
  return orders.map((o) => {
    let ticket = 0n;
    if (o.side === 'buy' && o.class === 1) {
      ticket = nextTicket.get(o.price) ?? 0n;
      nextTicket.set(o.price, ticket + 1n);
    }
    const crosses = o.side === 'buy' ? o.price >= c.price : o.price <= c.price;
    if (!crosses) return 0n;
    const isMarginal = o.price === c.price && c.rationed === o.side;
    if (!isMarginal) return o.quantity;
    if (o.side === 'sell') {
      const atSell = orders.filter((x) => x.side === 'sell' && x.price === c.price).reduce((a, x) => a + x.quantity, 0n);
      const sellBetter = orders.filter((x) => x.side === 'sell' && x.price < c.price).reduce((a, x) => a + x.quantity, 0n);
      return ceilDiv(o.quantity * (c.matched - sellBetter), atSell);
    }
    if (!pl) return (o.quantity * m.remaining) / m.q;
    let reserved = 0n;
    if (o.class === 1 && rules.lotteryUnit > 0n) {
      const n = m.tickets;
      const offset = (((ticket - rules.rho) % n) + n) % n;
      reserved = offset < pl.winners ? min(rules.lotteryUnit, o.quantity) : 0n;
    } else if (o.class >= 1 && o.class <= 3) {
      const i = o.class - 1;
      reserved = m.classQty[i]! === 0n ? 0n : (o.quantity * pl.reserved[i]!) / m.classQty[i]!;
    }
    const left = o.quantity - reserved;
    const residual = pl.residualBase === 0n ? 0n : (left * pl.residual) / pl.residualBase;
    return min(reserved + residual, o.quantity);
  });
}

/** Upper bound on the allocation of declared insiders (class 0): ADR-0106. */
export function referenceInsiderBound(orders: Order2[], c: Clearing2, rules: Rules2): bigint {
  const ins = orders.filter((o) => o.side === 'buy' && o.insider);
  if (ins.length === 0) return 0n;
  const better = ins.filter((o) => o.price > c.price).reduce((a, o) => a + o.quantity, 0n);
  const at = ins.filter((o) => o.price === c.price).reduce((a, o) => a + o.quantity, 0n);
  if (c.rationed !== 'buy') return better + at;
  const m = marginal(orders, c);
  const pl = isDefaultPolicy(rules) ? null : pools(orders, c, rules);
  const [num, den] = pl ? [pl.residual, pl.residualBase] : [m.remaining, m.q];
  if (den === 0n) return better;
  const part = ceilDiv(at * num, den);
  return better + min(part, at);
}
