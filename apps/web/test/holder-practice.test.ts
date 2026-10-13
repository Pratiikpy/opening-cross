import { describe, expect, it } from 'vitest';
import { referenceClear } from '../../../packages/verifier/src/reference';
import { clearBook } from '../src/components/cross/clearing';
import { DURATION, GRID, levelsAt, outcome, rng, scenario } from '../src/lib/holder-practice';

describe('practice scenario', () => {
  it('is the same every time for the same seed, and different for another', () => {
    expect(scenario(7)).toEqual(scenario(7));
    expect(scenario(7)).not.toEqual(scenario(8));
    const a = rng(1);
    const b = rng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('keeps every simulated order on the grid and inside the call', () => {
    const min = BigInt(GRID.minPrice);
    const tick = BigInt(GRID.tick);
    for (const seed of [1, 2, 3, 99, 12345]) {
      for (const o of scenario(seed)) {
        expect((o.price - min) % tick).toBe(0n);
        expect(o.price >= min && o.price <= min + BigInt(GRID.ticks - 1) * tick).toBe(true);
        expect(o.at >= 0 && o.at < DURATION).toBe(true);
        expect(o.quantity > 0n).toBe(true);
      }
    }
  });

  it('shows only the orders that have arrived', () => {
    const s = scenario(5);
    const early = levelsAt(s, 0, null).reduce((n, l) => n + l.buyOrders + l.sellOrders, 0);
    const late = levelsAt(s, DURATION, null).reduce((n, l) => n + l.buyOrders + l.sellOrders, 0);
    expect(early).toBe(s.filter((o) => o.at <= 0).length);
    expect(late).toBe(s.length);
  });
});

describe('practice outcome', () => {
  it('clears at the same price as the verifier reference for the whole book, learner included', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const orders = scenario(seed);
      const mine = { side: 'buy' as const, price: 1_500_000n, quantity: 120_000_000n };
      const o = outcome(orders, mine);
      const all = [...orders.map((x) => ({ side: x.side, price: x.price, quantity: x.quantity })), { side: mine.side, price: mine.price, quantity: mine.quantity }];
      const ref = referenceClear(all, { min: BigInt(GRID.minPrice), tick: BigInt(GRID.tick), ticks: GRID.ticks }, null);
      if (ref) {
        expect(o.cleared?.price).toBe(ref.price);
        expect(o.cleared?.matched).toBe(ref.matched);
      } else expect(o.cleared).toBeNull();
    }
  });

  it('charges a filled buyer the clearing price, never their limit, and refunds the rest', () => {
    const orders = scenario(3);
    const mine = { side: 'buy' as const, price: 1_900_000n, quantity: 100_000_000n };
    const o = outcome(orders, mine);
    expect(o.cleared).not.toBeNull();
    expect(o.escrow).toBe(190_000_000n);
    expect(o.paid).toBe((o.fill * o.cleared!.price + 999_999n) / 1_000_000n);
    expect(o.refund).toBe(o.escrow - o.paid);
    expect(o.paid <= o.escrow).toBe(true);
  });

  it('does not fill a bid below the clearing price, and refunds all of it', () => {
    const o = outcome(scenario(3), { side: 'buy', price: 1_000_000n, quantity: 50_000_000n });
    expect(o.fill).toBe(0n);
    expect(o.paid).toBe(0n);
    expect(o.refund).toBe(o.escrow);
  });

  it('shows that a higher limit pays the same price', () => {
    const orders = scenario(3);
    const mine = { side: 'buy' as const, price: 1_700_000n, quantity: 30_000_000n };
    const o = outcome(orders, mine);
    expect(o.higher).not.toBeNull();
    if (o.fill === mine.quantity && o.higher!.fill === mine.quantity) expect(o.higher!.paid).toBe(o.paid);
  });

  it('answers for a call with no learner order, and with the book as clearBook sees it', () => {
    const orders = scenario(2);
    expect(outcome(orders, null).cleared).toEqual(clearBook(levelsAt(orders, DURATION, null), GRID));
    expect(outcome(orders, null).fill).toBe(0n);
  });
});
