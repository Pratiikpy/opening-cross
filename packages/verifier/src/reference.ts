// Independent TypeScript implementation of the ADR-0003 clearing rule, written from the ADR
// text rather than from clearing-core, so the on-chain result is checked against a second
// implementation (differential testing). Exhaustive over every grid price.

export type Side = 'buy' | 'sell';
export interface RefOrder {
  side: Side;
  price: bigint;
  quantity: bigint;
}
export interface RefClearing {
  price: bigint;
  matched: bigint;
  rationed: Side | null;
}

export function referenceClear(orders: RefOrder[], grid: { min: bigint; tick: bigint; ticks: number }, reference: bigint | null): RefClearing | null {
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
    const v = d < s ? d : s;
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
  return { price: best.price, matched: best.matched, rationed: best.d > best.s ? 'buy' : best.s > best.d ? 'sell' : null };
}

/** Per-order fills under ADR-0003 rationing (buys floor, sells ceil). */
export function referenceFills(orders: RefOrder[], c: RefClearing): bigint[] {
  const better = (o: RefOrder) => (o.side === 'buy' ? o.price > c.price : o.price < c.price);
  const crosses = (o: RefOrder) => (o.side === 'buy' ? o.price >= c.price : o.price <= c.price);
  const strictlyBetter = (side: Side) => orders.filter((o) => o.side === side && better(o)).reduce((a, o) => a + o.quantity, 0n);
  const atPrice = (side: Side) => orders.filter((o) => o.side === side && o.price === c.price).reduce((a, o) => a + o.quantity, 0n);
  return orders.map((o) => {
    if (!crosses(o)) return 0n;
    if (o.price !== c.price || c.rationed !== o.side) return o.quantity;
    const q = atPrice(o.side);
    const r = c.matched - strictlyBetter(o.side);
    return o.side === 'buy' ? (o.quantity * r) / q : ceilDiv(o.quantity * r, q);
  });
}

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const abs = (x: bigint) => (x < 0n ? -x : x);
