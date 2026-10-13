import { describe, expect, it } from 'vitest';
import type { Grid, Level } from '../src/components/cross/clearing';
import { previewOrder } from '../src/components/cross/preview';

const grid: Grid = { minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000' };
const market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
const T = (n: number) => BigInt(Math.round(n * 1_000_000)); // tokens or quote, 6 decimals
const level = (price: number, buy: number, sell: number): Level => ({ price: String(T(price)), buy: String(T(buy)), sell: String(T(sell)), buyOrders: buy ? 1 : 0, sellOrders: sell ? 1 : 0 });
// 1,000 offered at 1.20 and 600 wanted at 1.30: the book clears at 1.20 for 600.
const book = { levels: [level(1.2, 0, 1000), level(1.3, 600, 0)], indicative: { price: String(T(1.2)), matched: String(T(600)) } };
const base = { market, grid, feeBps: 25, sealed: false, book };

describe('previewOrder: buy', () => {
  it('locks the most the order can cost, and shows the best and worst case in full', () => {
    const p = previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.escrow).toBe(T(150));
    expect(p.escrowIs).toBe('quote');
    expect(p.best).toEqual({ price: T(1.2), quote: T(120), other: T(30) }); // pays 120, 30 comes back
    expect(p.worst).toEqual({ price: T(1.5), quote: T(150), other: 0n });
    expect(p.bestMissing).toBeNull();
  });

  it('rounds what a buyer pays up, as cross_core does', () => {
    // 3 atoms at a price of 1.5 quote per token: ceil(3 × 1_500_000 / 1_000_000) = 5 (4.5 rounded up).
    const p = previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: 3n });
    expect(p.escrow).toBe(5n);
  });

  it('says so when the limit does not reach the indicative price', () => {
    const p = previewOrder({ ...base, side: 'buy', price: T(1.1), quantity: T(100) });
    expect(p.best).toBeNull();
    expect(p.bestMissing).toBe('limit-does-not-reach');
    expect(p.worst.quote).toBe(T(110));
  });

  it('measures the share against the supply offered at or below the limit', () => {
    const p = previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.share).toEqual({ against: T(1000), bps: 1000n, of: 'offered-at-limit' });
    // Nothing is offered at or below 1.1, so there is no share to state.
    const none = previewOrder({ ...base, side: 'buy', price: T(1.1), quantity: T(100) });
    expect(none.share).toBeNull();
    expect(none.shareMissing).toBe('nothing-offered');
    // Asking for more than is offered shows above 100%.
    expect(previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: T(2000) }).share?.bps).toBe(20_000n);
  });

  it('shows no price impact when the order does not move the indicative price', () => {
    const p = previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.impact).toEqual({ before: T(1.2), after: T(1.2), bps: 0n, fill: T(100) });
  });

  it('shows the move when a large bid pushes the price up', () => {
    const p = previewOrder({ ...base, side: 'buy', price: T(1.5), quantity: T(800) });
    // (1.30 - 1.20) / 1.20 = 8.33% -> 833 bps toward zero.
    expect(p.impact).toEqual({ before: T(1.2), after: T(1.3), bps: 833n, fill: T(800) });
  });

  it('shows the first price when the order creates the crossing', () => {
    const sellOnly = { levels: [level(1.2, 0, 1000)], indicative: null };
    const p = previewOrder({ ...base, book: sellOnly, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.indicative).toBeNull();
    expect(p.bestMissing).toBe('no-indicative');
    expect(p.impact).toMatchObject({ before: null, after: T(1.2), bps: null, fill: T(100) });
  });

  it('refuses to guess when the rule cannot reproduce the reported indicative price', () => {
    const stale = { levels: book.levels, indicative: { price: String(T(1.25)), matched: String(T(600)) } };
    const p = previewOrder({ ...base, book: stale, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.impact).toBeNull();
    expect(p.impactMissing).toBe('unverified');
  });

  it('says the book is not loaded rather than inventing figures', () => {
    const p = previewOrder({ ...base, book: null, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.impact).toBeNull();
    expect(p.impactMissing).toBe('no-book');
    expect(p.escrow).toBe(T(150));
    expect(p.best).toBeNull();
  });
});

describe('previewOrder: sell', () => {
  it('locks the tokens and nets the seller fee off what is received', () => {
    const p = previewOrder({ ...base, side: 'sell', price: T(1.1), quantity: T(100) });
    expect(p.escrow).toBe(T(100));
    expect(p.escrowIs).toBe('base');
    // 100 × 1.20 = 120; 25 bps of that is 0.30, rounded down.
    expect(p.best).toEqual({ price: T(1.2), quote: T(119.7), other: T(0.3) });
    // 100 × 1.10 = 110; 25 bps is 0.275.
    expect(p.worst).toEqual({ price: T(1.1), quote: T(109.725), other: T(0.275) });
  });

  it('does not reach the indicative price when the ask is above it', () => {
    const p = previewOrder({ ...base, side: 'sell', price: T(1.4), quantity: T(100) });
    expect(p.bestMissing).toBe('limit-does-not-reach');
  });

  it('states the share of the supply once the order is added', () => {
    const p = previewOrder({ ...base, side: 'sell', price: T(1.1), quantity: T(250) });
    expect(p.share).toEqual({ against: T(1250), bps: 2000n, of: 'supply-with-order' });
  });
});

describe('previewOrder: sealed', () => {
  it('shows only what the order itself fixes and says the book is hidden', () => {
    const p = previewOrder({ ...base, sealed: true, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.hidden).toBe(true);
    expect(p.escrow).toBe(T(150));
    expect(p.indicative).toBeNull();
    expect(p.best).toBeNull();
    expect(p.bestMissing).toBe('hidden');
    expect(p.impact).toBeNull();
    expect(p.impactMissing).toBe('hidden');
    // The supply side is public, so the share can still be stated.
    expect(p.share?.bps).toBe(1000n);
  });

  it('has no share when no supply is visible', () => {
    const p = previewOrder({ ...base, sealed: true, book: { levels: [], indicative: null }, side: 'buy', price: T(1.5), quantity: T(100) });
    expect(p.share).toBeNull();
    expect(p.shareMissing).toBe('nothing-offered');
  });
});
