// The v2 module against the conformance vectors that the on-chain code generated (`opening-cross/conformance/v2`: 437 cases of supply caps,
// the raise, float, valuation and price-move guards, allocation classes, the class-1 lottery and declared insiders), and the v1 vectors
// again through the same module with no v2 rule set, which must change nothing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClearingInputError, loadClearing, loadClearingV2, type ClearingV2, type OrderV2, type RulesV2 } from '../src/index.js';

interface V2Case {
  name: string;
  grid: { min: string; tick: string; ticks: number };
  reference: string | null;
  guards: { minMatched: string; maxImbalanceBps: number | null };
  rules: { supplyCap: string | null; minRaiseQuote: string; priceScale: string; totalSupply: string; minFloatBps: number; maxFdvX100: string; anchorPrice: string; moveBps: number; reserveBps: [number, number, number]; lotteryUnit: string; rho: number };
  orders: { side: 'buy' | 'sell'; price: string; quantity: string; class: 0 | 1 | 2 | 3; insider: boolean }[];
  expect: { printed: boolean; noPrintReason?: string; wouldClearAt?: string; price?: string; matched?: string; rationed?: string; insiderUpperBound?: string; fills?: string[] };
}
interface V1Case {
  name: string;
  grid: { min: string; tick: string; ticks: number };
  reference: string | null;
  guards: { minMatched: string; maxImbalanceBps: number | null };
  orders: { side: 'buy' | 'sell'; price: string; quantity: string }[];
  expect: { printed: boolean; noPrintReason?: string; price?: string; matched?: string; rationed?: string; fills?: string[] };
}
const read = <T>(file: string): T[] => (JSON.parse(readFileSync(new URL(`../../verifier/conformance/${file}`, import.meta.url), 'utf8')) as { cases: T[] }).cases;
const v2 = read<V2Case>('v2.json');
const v1 = read<V1Case>('v1.json');
const rule: Promise<ClearingV2> = loadClearingV2(readFileSync(new URL('../clearing-v2.wasm', import.meta.url)));

const rulesOf = (r: V2Case['rules']): RulesV2 => ({
  supplyCap: r.supplyCap === null ? null : BigInt(r.supplyCap),
  minRaiseQuote: BigInt(r.minRaiseQuote),
  priceScale: BigInt(r.priceScale),
  totalSupply: BigInt(r.totalSupply),
  minFloatBps: r.minFloatBps,
  maxFdvX100: BigInt(r.maxFdvX100),
  anchorPrice: BigInt(r.anchorPrice),
  moveBps: r.moveBps,
  reserveBps: r.reserveBps,
  lotteryUnit: BigInt(r.lotteryUnit),
  rho: r.rho,
});

describe('the v2 module reproduces the conformance vectors the program generated', () => {
  it('all 437, fills, insider bounds and the place a guard stopped the cross included', async () => {
    const r = await rule;
    expect(v2).toHaveLength(437);
    const reasons = new Set<string>();
    let printed = 0;
    for (const c of v2) {
      const p = r.preview({
        grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks },
        orders: c.orders.map((o): OrderV2 => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity), class: o.class, insider: o.insider })),
        reference: c.reference === null ? null : BigInt(c.reference),
        minMatched: BigInt(c.guards.minMatched),
        maxImbalanceBps: c.guards.maxImbalanceBps,
        rules: rulesOf(c.rules),
      });
      expect(p.printed, c.name).toBe(c.expect.printed);
      if (!p.printed) {
        expect(p.reason, c.name).toBe(c.expect.noPrintReason);
        reasons.add(p.reason);
        if (p.reason !== 'NoCross') expect(String(p.wouldClearAt), c.name).toBe(c.expect.wouldClearAt);
        expect(p.fills.every((f) => f === 0n), c.name).toBe(true);
      } else {
        printed++;
        expect([String(p.price), String(p.matched), p.rationed ?? 'none', String(p.insiderUpperBound)], c.name).toEqual([c.expect.price, c.expect.matched, c.expect.rationed, c.expect.insiderUpperBound]);
        expect(p.fills.map(String), c.name).toEqual(c.expect.fills);
      }
    }
    // The vectors exercise every guard: a green run over cases that never hit a branch would prove nothing.
    expect([...reasons].sort()).toEqual(['BelowMinimumRaise', 'BelowMinimumVolume', 'FdvTooHigh', 'FloatTooLow', 'ImbalanceTooHigh', 'NoCross', 'PriceMoved']);
    expect(printed).toBeGreaterThan(150);
  });

  it('the v1 vectors give the same answers with no v2 rule set, and agree with the v1 module on every field both report', async () => {
    const r = await rule;
    const old = await loadClearing(readFileSync(new URL('../clearing.wasm', import.meta.url)));
    expect(v1).toHaveLength(525);
    for (const c of v1) {
      const input = {
        grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks },
        orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity) })),
        reference: c.reference === null ? null : BigInt(c.reference),
        minMatched: BigInt(c.guards.minMatched),
        maxImbalanceBps: c.guards.maxImbalanceBps,
      };
      const a = r.preview(input);
      const b = old.preview(input);
      expect(a.printed, c.name).toBe(c.expect.printed);
      expect(a.fills.map(String), c.name).toEqual(b.fills.map(String));
      if (!a.printed) expect(a.reason, c.name).toBe(c.expect.noPrintReason);
      else if (b.printed) expect([String(a.price), String(a.matched), String(a.demand), String(a.supply), a.rationed, a.marginalOrders, String(a.marginalQuantity), String(a.marginalRemaining)], c.name).toEqual([String(b.price), String(b.matched), String(b.demand), String(b.supply), b.rationed, b.marginalOrders, String(b.marginalQuantity), String(b.marginalRemaining)]);
    }
  });

  it('reduces the lottery start modulo the tickets, as the program does, whatever number it is given', async () => {
    const r = await rule;
    const c = v2.find((x) => x.name === 'lottery: ten tickets, window starts at 3')!;
    const run = (rho: number) =>
      r.preview({
        grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks },
        orders: c.orders.map((o): OrderV2 => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity), class: o.class, insider: o.insider })),
        rules: { ...rulesOf(c.rules), rho },
      });
    const base = run(3);
    expect(base.printed && base.lotteryTickets).toBe(10);
    for (const rho of [13, 23, 1_000_003, 0xffff_fff3]) {
      const p = run(rho);
      expect(p, `rho ${rho}`).toEqual(base);
      expect(p.printed && p.lotteryRho).toBe(3);
    }
    // A different window really does change who wins, so the equality above is not vacuous.
    expect(run(4).fills).not.toEqual(base.fills);
  });

  it('answers the same book the same way twice, and does not let one call disturb the next', async () => {
    const r = await rule;
    const c = v2[200]!;
    const input = {
      grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks },
      orders: c.orders.map((o): OrderV2 => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity), class: o.class, insider: o.insider })),
      rules: rulesOf(c.rules),
    };
    const first = r.preview(input);
    for (let i = 0; i < 2_000; i++) r.preview(input);
    expect(r.preview(input)).toEqual(first);
  });
});

describe('the v2 module refuses what the program refuses', () => {
  const grid = { min: 100n, tick: 10n, ticks: 20 };
  const book: OrderV2[] = [{ side: 'sell', price: 100n, quantity: 10n }, { side: 'buy', price: 100n, quantity: 10n }];
  it('a bad rule set, a class or flag on a sell, a class out of range, and the base refusals', async () => {
    const r = await rule;
    expect(() => r.preview({ grid, orders: book, rules: { priceScale: 0n } })).toThrow(/rules are not valid/);
    expect(() => r.preview({ grid, orders: book, rules: { reserveBps: [6_000, 5_000, 0] } })).toThrow(/rules are not valid/);
    expect(() => r.preview({ grid, orders: [{ side: 'sell', price: 100n, quantity: 1n, class: 2 }] })).toThrow(/malformed/);
    expect(() => r.preview({ grid, orders: [{ side: 'sell', price: 100n, quantity: 1n, insider: true }] })).toThrow(/malformed/);
    expect(() => r.preview({ grid, orders: [{ side: 'buy', price: 100n, quantity: 1n, class: 4 as 3 }] })).toThrow(/malformed/);
    expect(() => r.preview({ grid, orders: [{ side: 'buy', price: 155n, quantity: 1n }] })).toThrow(/not on the grid/);
    expect(() => r.preview({ grid, orders: [], reference: 155n })).toThrow(/reference/);
    expect(() => r.preview({ grid: { min: 100n, tick: 0n, ticks: 20 }, orders: book })).toThrow(/grid is not valid/);
    expect(() => r.preview({ grid: { min: 100n, tick: 10n, ticks: 70_000 }, orders: book })).toThrow(ClearingInputError);
  });
  it('numbers that do not fit the module\'s widths are refused before anything is called', async () => {
    const r = await rule;
    expect(() => r.preview({ grid, orders: book, rules: { supplyCap: 1n << 64n } })).toThrow(/64 bits/);
    expect(() => r.preview({ grid, orders: book, rules: { minFloatBps: -1 } })).toThrow(/whole number/);
    expect(() => r.preview({ grid, orders: book, rules: { reserveBps: [70_000, 0, 0] } })).toThrow(/whole number from 0 to 65535/);
    expect(() => r.preview({ grid, orders: book, rules: { moveBps: 1.5 } })).toThrow(/whole number/);
    expect(() => r.preview({ grid, orders: book, minMatched: -1n })).toThrow(/64 bits/);
    // Still usable afterwards.
    expect(r.preview({ grid, orders: book }).printed).toBe(true);
  });
  it('prices money exactly as the base module does', async () => {
    const r = await rule;
    expect(r.buyerPays(3n, 150n, 100n)).toBe(5n);
    expect(r.sellerReceives(3n, 150n, 100n)).toBe(4n);
    expect(() => r.buyerPays((1n << 64n) - 1n, (1n << 64n) - 1n, 1n)).toThrow(/64 bits/);
  });
});
