// Conformance suite v2 (`opening-cross/conformance/v2`): the rules added after ADR-0003. Same
// shape of contract as v1 — any implementation passes only if it reproduces every case exactly —
// for the supply cap, the raise/float/valuation/price-move guards, allocation classes with the
// class-1 lottery, and the exclusion of declared insiders from the minimum raise.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Order2,
  type Rules2,
  referenceClearCapped,
  referenceFills2,
  referenceGuards2,
  referenceInsiderBound,
} from './reference2.js';

export const CONFORMANCE2_SCHEMA = 'opening-cross/conformance/v2';

export type ConformanceCase2 = {
  name: string;
  grid: { min: string; tick: string; ticks: number };
  reference: string | null;
  guards: { minMatched: string; maxImbalanceBps: number | null };
  rules: {
    supplyCap: string | null;
    minRaiseQuote: string;
    priceScale: string;
    totalSupply: string;
    minFloatBps: number;
    maxFdvX100: string;
    anchorPrice: string;
    moveBps: number;
    reserveBps: [number, number, number];
    lotteryUnit: string;
    rho: number;
  };
  orders: { side: 'buy' | 'sell'; price: string; quantity: string; class: number; insider: boolean }[];
  expect:
    | { printed: false; noPrintReason: string; wouldClearAt?: string }
    | { printed: true; price: string; matched: string; rationed: 'none' | 'buy' | 'sell'; insiderUpperBound: string; fills: string[] };
};
export type ConformanceVectors2 = { schema: string; cases: ConformanceCase2[] };
export type ConformanceResult2 = ConformanceCase2['expect'];
export type Implementation2 = (c: ConformanceCase2) => ConformanceResult2;

export function loadVectors2(path = fileURLToPath(new URL('../conformance/v2.json', import.meta.url))): ConformanceVectors2 {
  const v = JSON.parse(readFileSync(path, 'utf8')) as ConformanceVectors2;
  if (v.schema !== CONFORMANCE2_SCHEMA) throw new Error(`unexpected schema ${v.schema}`);
  return v;
}

const canonical = (r: ConformanceResult2) =>
  r.printed ? JSON.stringify([true, r.price, r.matched, r.rationed, r.insiderUpperBound, r.fills]) : JSON.stringify([false, r.noPrintReason, r.wouldClearAt ?? null]);

export function runConformance2(vectors: ConformanceVectors2, impl: Implementation2): { name: string; expected: ConformanceResult2; actual: ConformanceResult2 | string }[] {
  const failures: { name: string; expected: ConformanceResult2; actual: ConformanceResult2 | string }[] = [];
  for (const c of vectors.cases) {
    let actual: ConformanceResult2 | string;
    try {
      actual = impl(c);
    } catch (e) {
      actual = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (typeof actual === 'string' || canonical(actual) !== canonical(c.expect)) failures.push({ name: c.name, expected: c.expect, actual });
  }
  return failures;
}

export function rulesOf(c: ConformanceCase2): Rules2 {
  const r = c.rules;
  return {
    supplyCap: r.supplyCap === null ? null : BigInt(r.supplyCap),
    minRaiseQuote: BigInt(r.minRaiseQuote),
    priceScale: BigInt(r.priceScale),
    totalSupply: BigInt(r.totalSupply),
    minFloatBps: BigInt(r.minFloatBps),
    maxFdvX100: BigInt(r.maxFdvX100),
    anchorPrice: BigInt(r.anchorPrice),
    moveBps: BigInt(r.moveBps),
    reserveBps: [BigInt(r.reserveBps[0]), BigInt(r.reserveBps[1]), BigInt(r.reserveBps[2])],
    lotteryUnit: BigInt(r.lotteryUnit),
    rho: BigInt(r.rho),
  };
}

/** The verifier's own implementation of the v2 rules. */
export const referenceImplementation2: Implementation2 = (c) => {
  const orders: Order2[] = c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity), class: o.class, insider: o.insider }));
  const rules = rulesOf(c);
  const cl = referenceClearCapped(orders, { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks }, c.reference === null ? null : BigInt(c.reference), rules.supplyCap);
  if (!cl) return { printed: false, noPrintReason: 'NoCross' };
  const ub = referenceInsiderBound(orders, cl, rules);
  const counted = cl.matched > ub ? cl.matched - ub : 0n;
  const failure = referenceGuards2(cl, counted, rules, { minMatched: BigInt(c.guards.minMatched), maxImbalanceBps: c.guards.maxImbalanceBps === null ? null : BigInt(c.guards.maxImbalanceBps) });
  if (failure) return { printed: false, noPrintReason: failure, wouldClearAt: cl.price.toString() };
  return {
    printed: true,
    price: cl.price.toString(),
    matched: cl.matched.toString(),
    rationed: cl.rationed ?? 'none',
    insiderUpperBound: ub.toString(),
    fills: referenceFills2(orders, cl, rules).map(String),
  };
};
