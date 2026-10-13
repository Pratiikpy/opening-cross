/**
 * Uniform-price call-auction clearing.
 *
 * `clearAdr` implements docs/adr/0003-clearing-rule.md on an integer tick grid:
 *   V(p) = min(D(p), S(p)), feasible iff V(p) >= max(D+(p), S-(p));
 *   choose the feasible price with V > 0 by (1) max V, (2) min |D - S|, (3) reference price (none here),
 *   (4) lowest price. Orders strictly better than P* fill in full; orders AT P* on the excess
 *   side are rationed pro-rata: buys get floor(q R / Q), sells get ceil(q R / Q).
 *
 * All quantities are bigint atoms so nothing is lost to float rounding. Every grid tick is
 * evaluated. D and S are constant inside a gap between consecutive limits, so evaluating every
 * tick and breaking ties on the lowest price selects exactly the ADR candidate set (order limits
 * plus the lowest tick of each gap).
 *
 * `clearBudget` is the original model's demand curve (research/scripts/sim/sim.py:328-353): each
 * bidder spends a budget, so demand at price p is budget / p while p <= limit. Kept only so the
 * port can be compared with the Python results.
 */

export interface Level {
  /** Index on the price grid (price = floor * (1 + tick)^idx). */
  idx: number;
  qty: bigint;
}

export interface Clearing {
  idx: number;
  volume: bigint;
  demand: bigint; // D(P*)
  supply: bigint; // S(P*)
  demandAbove: bigint; // D+(P*)
  supplyBelow: bigint; // S-(P*)
  /** Marginal (rationed) side: "buy" when demand exceeds supply at P*, "sell" when supply does, else "none". */
  rationed: "buy" | "sell" | "none";
  /** R: volume left for the marginal orders. */
  marginalVolume: bigint;
  /** Q: total quantity of the orders exactly at P* on the rationed side. */
  marginalQty: bigint;
}

function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function clearAdr(buys: readonly Level[], sells: readonly Level[]): Clearing | null {
  let maxIdx = -1;
  for (const l of buys) maxIdx = Math.max(maxIdx, l.idx);
  for (const l of sells) maxIdx = Math.max(maxIdx, l.idx);
  if (maxIdx < 0) return null;
  const n = maxIdx + 2;
  const bq: bigint[] = new Array<bigint>(n).fill(0n);
  const sq: bigint[] = new Array<bigint>(n).fill(0n);
  for (const l of buys) bq[l.idx] = bq[l.idx]! + l.qty;
  for (const l of sells) sq[l.idx] = sq[l.idx]! + l.qty;
  // D(k) = buys with limit >= k ; S(k) = sells with limit <= k
  const dGe: bigint[] = new Array<bigint>(n + 1).fill(0n);
  for (let k = n - 1; k >= 0; k--) dGe[k] = dGe[k + 1]! + bq[k]!;
  let best: { k: number; v: bigint; imb: bigint } | null = null;
  let sLe = 0n; // S(k)
  let sLt = 0n; // S-(k)
  for (let k = 0; k < n; k++) {
    sLt = sLe;
    sLe += sq[k]!;
    const d = dGe[k]!;
    const dPlus = dGe[k + 1]!;
    const v = d < sLe ? d : sLe;
    if (v <= 0n) continue;
    const need = dPlus > sLt ? dPlus : sLt;
    if (v < need) continue; // infeasible: a strictly better order would not fit
    const imb = absBig(d - sLe);
    if (best === null || v > best.v || (v === best.v && imb < best.imb)) {
      best = { k, v, imb }; // equal (v, imb): keep the earlier, i.e. lower, tick
    }
  }
  if (best === null) return null;
  const k = best.k;
  const d = dGe[k]!;
  let s = 0n;
  let sBelow = 0n;
  for (let i = 0; i <= k; i++) {
    s += sq[i]!;
    if (i < k) sBelow += sq[i]!;
  }
  const dPlus = dGe[k + 1]!;
  let rationed: Clearing["rationed"] = "none";
  let marginalVolume = 0n;
  let marginalQty = 0n;
  if (d > s) {
    rationed = "buy";
    marginalQty = bq[k]!;
    marginalVolume = best.v - dPlus;
  } else if (s > d) {
    rationed = "sell";
    marginalQty = sq[k]!;
    marginalVolume = best.v - sBelow;
  }
  return {
    idx: k,
    volume: best.v,
    demand: d,
    supply: s,
    demandAbove: dPlus,
    supplyBelow: sBelow,
    rationed,
    marginalVolume,
    marginalQty,
  };
}

/** Fill of one buy order of `qty` at tick `idx` against a clearing summary (ADR-0003 "Fills"). */
export function fillBuy(idx: number, qty: bigint, c: Clearing): bigint {
  if (idx > c.idx) return qty;
  if (idx < c.idx) return 0n;
  if (c.rationed === "buy" && c.marginalQty > 0n) return (qty * c.marginalVolume) / c.marginalQty; // floor
  return qty;
}

/** Fill of one sell order (ADR-0003: rationed sells round up, never above the order). */
export function fillSell(idx: number, qty: bigint, c: Clearing): bigint {
  if (idx < c.idx) return qty;
  if (idx > c.idx) return 0n;
  if (c.rationed === "sell" && c.marginalQty > 0n) {
    const f = (qty * c.marginalVolume + c.marginalQty - 1n) / c.marginalQty; // ceil
    return f > qty ? qty : f;
  }
  return qty;
}

/** Buyers pay ceil(fill * price / scale); sellers receive floor (ADR-0003 "Payment rounding"). */
export function buyerPays(fill: bigint, price: bigint, scale: bigint): bigint {
  return (fill * price + scale - 1n) / scale;
}
export function sellerReceives(fill: bigint, price: bigint, scale: bigint): bigint {
  return (fill * price) / scale;
}

export interface BudgetBid {
  budget: number;
  limit: number;
  cap: number;
}

/**
 * The original model's clearing (sim.py:_uniform_clear). Returns the price and tokens per bidder.
 * Highest tick at which demand still covers supply, pro-rata among those exactly at the margin.
 */
export function clearBudget(
  budget: Float64Array,
  limit: Float64Array,
  S: number,
  floor: number,
  tick = 0.01,
): { price: number; alloc: Float64Array } {
  const n = budget.length;
  const demand = (p: number, out?: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = limit[i]! >= p ? budget[i]! / p : 0;
      if (out) out[i] = d;
      s += d;
    }
    return s;
  };
  const alloc = new Float64Array(n);
  if (demand(floor, alloc) <= S) return { price: floor, alloc };
  let maxLimit = floor;
  for (let i = 0; i < n; i++) maxLimit = Math.max(maxLimit, limit[i]!);
  let lo = 0;
  let hi = Math.trunc(Math.log(maxLimit / floor) / Math.log(1 + tick)) + 2;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (demand(floor * Math.pow(1 + tick, mid)) >= S) lo = mid;
    else hi = mid;
  }
  const p = floor * Math.pow(1 + tick, lo);
  const pNext = floor * Math.pow(1 + tick, lo + 1);
  const d = new Float64Array(n);
  demand(p, d);
  let strictSum = 0;
  let marginalSum = 0;
  const strict = new Float64Array(n);
  const marginal = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    strict[i] = limit[i]! >= pNext ? budget[i]! / p : 0;
    marginal[i] = d[i]! - strict[i]!;
    strictSum += strict[i]!;
    marginalSum += marginal[i]!;
  }
  const rem = S - strictSum;
  if (marginalSum > 0 && rem > 0) {
    const f = Math.min(1, rem / marginalSum);
    for (let i = 0; i < n; i++) alloc[i] = strict[i]! + marginal[i]! * f;
  } else {
    const f = strictSum > S ? S / strictSum : 1;
    for (let i = 0; i < n; i++) alloc[i] = strict[i]! * f;
  }
  return { price: p, alloc };
}
