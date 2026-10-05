import { describe, expect, it } from 'vitest';
import { referenceClear, referenceFills } from '../src/index.js';

const grid = { min: 100n, tick: 10n, ticks: 10 };

describe('reference clearing (ADR-0003)', () => {
  it('picks max volume, then min imbalance, then the lowest price', () => {
    const r = referenceClear([{ side: 'sell', price: 100n, quantity: 10n }, { side: 'buy', price: 120n, quantity: 10n }], grid, null);
    expect(r).toEqual({ price: 100n, matched: 10n, rationed: null });
  });

  it('uses the reference price to break ties', () => {
    const r = referenceClear([{ side: 'sell', price: 100n, quantity: 10n }, { side: 'buy', price: 120n, quantity: 10n }], grid, 120n);
    expect(r?.price).toBe(120n);
  });

  it('rations the excess side pro rata: buys round down, sells round up', () => {
    const orders = [{ side: 'sell' as const, price: 100n, quantity: 100n }, { side: 'buy' as const, price: 100n, quantity: 150n }, { side: 'buy' as const, price: 100n, quantity: 50n }];
    const r = referenceClear(orders, grid, null)!;
    expect(r.rationed).toBe('buy');
    expect(referenceFills(orders, r)).toEqual([100n, 75n, 25n]);
  });

  it('returns null when nothing crosses', () => {
    expect(referenceClear([{ side: 'sell', price: 150n, quantity: 1n }, { side: 'buy', price: 140n, quantity: 1n }], grid, null)).toBeNull();
  });
});
