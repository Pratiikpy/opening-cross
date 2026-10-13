import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Clearing, ClearingInputError, loadClearing } from '../src/index.js';

interface Case {
  name: string;
  grid: { min: string; tick: string; ticks: number };
  reference: string | null;
  guards: { minMatched: string; maxImbalanceBps: number | null };
  orders: { side: 'buy' | 'sell'; price: string; quantity: string }[];
  expect: { printed: boolean; noPrintReason?: string; price?: string; matched?: string; rationed?: string; fills?: string[] };
}
const vectors = (JSON.parse(readFileSync(new URL('../../verifier/conformance/v1.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;
const rule: Promise<Clearing> = loadClearing(readFileSync(new URL('../clearing.wasm', import.meta.url)));

describe('the compiled rule', () => {
  it('reproduces all conformance vectors, fills included', async () => {
    const r = await rule;
    expect(vectors).toHaveLength(525);
    for (const c of vectors) {
      const p = r.preview({
        grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks },
        orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity) })),
        reference: c.reference === null ? null : BigInt(c.reference),
        minMatched: BigInt(c.guards.minMatched),
        maxImbalanceBps: c.guards.maxImbalanceBps,
      });
      expect(p.printed, c.name).toBe(c.expect.printed);
      if (!p.printed) {
        expect(p.reason, c.name).toBe(c.expect.noPrintReason);
      } else {
        expect([String(p.price), String(p.matched), p.rationed ?? 'none'], c.name).toEqual([c.expect.price, c.expect.matched, c.expect.rationed]);
        expect(p.fills.map(String), c.name).toEqual(c.expect.fills);
      }
    }
  });

  it('refuses what the program refuses, and rounds money the way it does', async () => {
    const r = await rule;
    const grid = { min: 100n, tick: 10n, ticks: 20 };
    expect(() => r.preview({ grid, orders: [{ side: 'buy', price: 155n, quantity: 1n }] })).toThrow(ClearingInputError);
    expect(() => r.preview({ grid, orders: [{ side: 'buy', price: 100n, quantity: 0n }] })).toThrow(/empty/);
    expect(() => r.preview({ grid, orders: [], reference: 155n })).toThrow(/reference/);
    expect(() => r.preview({ grid, orders: [{ side: 'buy', price: 1n << 64n, quantity: 1n }] })).toThrow(/64 bits/);
    expect(r.buyerPays(3n, 150n, 100n)).toBe(5n);
    expect(r.sellerReceives(3n, 150n, 100n)).toBe(4n);
    expect(() => r.buyerPays((1n << 64n) - 1n, (1n << 64n) - 1n, 1n)).toThrow(/64 bits/);
  });
});
