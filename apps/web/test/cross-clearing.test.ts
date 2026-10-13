import { describe, expect, it } from 'vitest';
import { referenceClear } from '../../../packages/verifier/src/reference';
import { type Grid, type Level, clearBook, fillAt, simulateAgainstIndicative } from '../src/components/cross/clearing';

const grid: Grid = { minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000' };
const lvl = (price: number, buy: number, sell: number): Level => ({ price: String(price * 1_000_000), buy: String(buy * 1_000_000), sell: String(sell * 1_000_000), buyOrders: buy ? 1 : 0, sellOrders: sell ? 1 : 0 });

describe('clearBook', () => {
  it('reproduces a cleared cross that is on the live API (F6SHDwoT…: 1.3 for 2,800)', () => {
    const levels: Level[] = [
      { price: '1000000', buy: '0', sell: '1500000000', buyOrders: 0, sellOrders: 1 },
      { price: '1300000', buy: '1800000000', sell: '1500000000', buyOrders: 1, sellOrders: 1 },
      { price: '1600000', buy: '1000000000', sell: '0', buyOrders: 1, sellOrders: 0 },
    ];
    expect(clearBook(levels, grid)).toEqual({ price: 1_300_000n, matched: 2_800_000_000n, rationed: 'sell' });
  });

  it('returns null when nothing crosses', () => {
    expect(clearBook([lvl(1.5, 0, 100), lvl(1.2, 100, 0)], grid)).toBeNull();
    expect(clearBook([], grid)).toBeNull();
  });

  it('moves the price up when a higher bid arrives, because the 1.2 bids must be able to fill in full', () => {
    const base = [lvl(1.2, 0, 1000), lvl(1.3, 600, 0)];
    expect(clearBook(base, grid)).toMatchObject({ price: 1_200_000n, matched: 600_000_000n });
    const moved = clearBook(base, grid, { side: 'buy', price: 1_500_000n, quantity: 800_000_000n });
    // At 1.2 the bids above it (1,400) exceed the supply (1,000), so 1.2 is infeasible; 1.3 trades the same volume.
    expect(moved).toMatchObject({ price: 1_300_000n, matched: 1_000_000_000n });
  });

  it('agrees with the verifier reference on 400 random books (differential test)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 400; t++) {
      const orders = Array.from({ length: 1 + rnd(8) }, () => ({
        side: rnd(2) ? ('buy' as const) : ('sell' as const),
        price: 1_000_000n + BigInt(rnd(20)) * 100_000n,
        quantity: BigInt(1 + rnd(50)) * 1_000_000n,
      }));
      const levels: Level[] = [];
      for (const o of orders) {
        let l = levels.find((x) => x.price === String(o.price));
        if (!l) levels.push((l = { price: String(o.price), buy: '0', sell: '0', buyOrders: 0, sellOrders: 0 }));
        l[o.side] = String(BigInt(l[o.side]) + o.quantity);
      }
      const mine = clearBook(levels, grid);
      const ref = referenceClear(orders, { min: 1_000_000n, tick: 100_000n, ticks: 20 }, null);
      expect(mine && { price: mine.price, matched: mine.matched, rationed: mine.rationed }).toEqual(ref);
    }
  });
});

describe('fillAt', () => {
  it('fills an order that beats the price in full and one that misses it not at all', () => {
    const levels = [lvl(1.2, 0, 1000), lvl(1.3, 600, 0)];
    const c = clearBook(levels, grid)!;
    expect(fillAt(levels, grid, c, { side: 'buy', price: 1_300_000n, quantity: 600_000_000n })).toBe(600_000_000n);
    expect(fillAt(levels, grid, c, { side: 'buy', price: 1_100_000n, quantity: 600_000_000n })).toBe(0n);
  });

  it('rations an order at the price on the heavy side: buys floor', () => {
    // 1,000 offered at 1.2; 1,500 bid at exactly 1.2 (mine is 500 of it): everyone at 1.2 gets 1000/1500.
    const levels = [lvl(1.2, 1000, 1000)];
    const mine = { side: 'buy' as const, price: 1_200_000n, quantity: 500_000_000n };
    const withMine = [lvl(1.2, 1500, 1000)];
    const c = clearBook(withMine, grid)!;
    expect(c).toMatchObject({ price: 1_200_000n, matched: 1_000_000_000n, rationed: 'buy' });
    expect(fillAt(levels, grid, c, mine)).toBe(333_333_333n);
  });
});

describe('simulateAgainstIndicative', () => {
  it('returns the move when the rule reproduces the API price', () => {
    const levels = [lvl(1.2, 0, 1000), lvl(1.3, 600, 0)];
    const book = { levels, indicative: { price: '1200000', matched: '600000000' } };
    const r = simulateAgainstIndicative(book, grid, { side: 'buy', price: 1_500_000n, quantity: 800_000_000n })!;
    expect(r.before?.price).toBe(1_200_000n);
    expect(r.after).toMatchObject({ price: 1_300_000n, matched: 1_000_000_000n });
    expect(r.fill).toBe(800_000_000n);
  });

  it('refuses when the rule disagrees with the reported price, instead of showing a wrong number', () => {
    const levels = [lvl(1.2, 0, 1000), lvl(1.3, 600, 0)];
    expect(simulateAgainstIndicative({ levels, indicative: { price: '1250000', matched: '600000000' } }, grid, { side: 'buy', price: 1_500_000n, quantity: 1n })).toBeNull();
    expect(simulateAgainstIndicative({ levels, indicative: null }, grid, { side: 'buy', price: 1_500_000n, quantity: 1n })).toBeNull();
  });

  it('works on an empty book where the API reports no price', () => {
    const r = simulateAgainstIndicative({ levels: [], indicative: null }, grid, { side: 'buy', price: 1_500_000n, quantity: 5n })!;
    expect(r.before).toBeNull();
    expect(r.after).toBeNull();
    expect(r.fill).toBe(0n);
  });
});
