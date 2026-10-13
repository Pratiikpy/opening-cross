import { describe, expect, it } from 'vitest';
import { OrderSide } from '../src/generated/types/orderSide.js';
import { compositeReference, newYorkToUnix, peggedOrder, usEquityHolidays, weeklyReopenSessions } from '../src/stocks.js';

const utc = (iso: string) => BigInt(Date.parse(iso) / 1000);

describe('usEquityHolidays', () => {
  it('2026 follows the usual rules (Saturday July 4 is observed on Friday July 3)', () => {
    expect(usEquityHolidays(2026)).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ]);
  });
  it('Good Friday comes from Easter, and a Saturday New Year is not observed', () => {
    expect(usEquityHolidays(2027)).toContain('2027-03-26'); // Easter 2027-03-28
    expect(usEquityHolidays(2022)).not.toContain('2021-12-31');
    expect(usEquityHolidays(2022)).not.toContain('2022-01-01');
  });
});

describe('newYorkToUnix', () => {
  it('knows the clock change: 09:30 is 14:30 UTC in winter and 13:30 UTC in summer', () => {
    expect(newYorkToUnix(2026, 1, 5, 9, 30)).toBe(utc('2026-01-05T14:30:00Z'));
    expect(newYorkToUnix(2026, 3, 9, 9, 30)).toBe(utc('2026-03-09T13:30:00Z'));
    // The day of the change itself: 2026-03-08 09:30 is already summer time.
    expect(newYorkToUnix(2026, 3, 8, 9, 30)).toBe(utc('2026-03-08T13:30:00Z'));
    expect(newYorkToUnix(2026, 11, 2, 9, 30)).toBe(utc('2026-11-02T14:30:00Z'));
  });
});

describe('weeklyReopenSessions', () => {
  it('returns the first session of each trading week, and skips a holiday Monday', () => {
    const s = weeklyReopenSessions({ fromUnix: utc('2026-01-01T00:00:00Z'), weeks: 4 });
    // Jan 1 (Thursday) is a holiday, so the first week opens Friday Jan 2; then Mondays Jan 5... but Jan 19 is MLK day.
    expect(s.map((x) => new Date(Number(x.startTs) * 1000).toISOString())).toEqual([
      '2026-01-02T14:30:00.000Z',
      '2026-01-05T14:30:00.000Z',
      '2026-01-12T14:30:00.000Z',
      '2026-01-20T14:30:00.000Z',
    ]);
    for (const x of s) expect(x.endTs - x.startTs).toBe(6n * 3600n + 30n * 60n);
  });
  it('daily mode returns every trading day, never overlapping, in order', () => {
    const s = weeklyReopenSessions({ fromUnix: utc('2026-06-01T00:00:00Z'), weeks: 3, mode: 'daily' });
    for (let i = 1; i < s.length; i++) expect(s[i]!.startTs >= s[i - 1]!.endTs).toBe(true);
    expect(s.length).toBe(14); // 15 weekdays less Juneteenth (Friday June 19)
  });
  it('fits a calendar: at most 64 weeks, an explicit holiday list overrides the rules', () => {
    expect(weeklyReopenSessions({ fromUnix: utc('2026-01-01T00:00:00Z'), weeks: 64 }).length).toBe(64);
    expect(() => weeklyReopenSessions({ fromUnix: 0n, weeks: 65 })).toThrow();
    const noHolidays = weeklyReopenSessions({ fromUnix: utc('2026-01-01T00:00:00Z'), weeks: 1, holidays: [] });
    expect(new Date(Number(noHolidays[0]!.startTs) * 1000).toISOString()).toBe('2026-01-01T14:30:00.000Z');
  });
});

describe('peggedOrder', () => {
  const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 21, priceScale: 1_000_000n };
  it('a buy at the top of the grid and a sell at the bottom, with exact escrow', () => {
    expect(peggedOrder(grid, OrderSide.Buy, 5_000_000n)).toEqual({ price: 3_000_000n, quantity: 5_000_000n, escrow: 15_000_000n });
    expect(peggedOrder(grid, OrderSide.Sell, 5_000_000n)).toEqual({ price: 1_000_000n, quantity: 5_000_000n, escrow: 5_000_000n });
  });
  it('a slippage bound rounds in the safe direction and stays on the grid', () => {
    const buy = peggedOrder(grid, OrderSide.Buy, 1_000_000n, { reference: 1_500_000n, slippageBps: 500 });
    expect(buy.price).toBe(1_600_000n); // 1.575 rounds up to the next tick
    const sell = peggedOrder(grid, OrderSide.Sell, 1_000_000n, { reference: 1_500_000n, slippageBps: 500 });
    expect(sell.price).toBe(1_400_000n); // 1.425 rounds down
    expect(peggedOrder(grid, OrderSide.Buy, 1n, { reference: 9_000_000n, slippageBps: 500 }).price).toBe(3_000_000n);
    expect(peggedOrder(grid, OrderSide.Sell, 1n, { reference: 100_000n, slippageBps: 500 }).price).toBe(1_000_000n);
  });
});

describe('compositeReference', () => {
  const rules = { now: 1_000_000n, maxAgeSecs: 86_400n, maxSpreadBps: 500, weights: { quote: 5_000, trade: 3_000, valuation: 2_000 } };
  it('weights the sources that qualify and ignores the rest', () => {
    const r = compositeReference({ bid: 99n, ask: 101n, lastTrade: { price: 110n, ts: 999_000n }, valuation: { price: 80n, ts: 100n } }, rules);
    expect(r).toEqual({ price: (100n * 5_000n + 110n * 3_000n) / 8_000n, sources: ['quote', 'trade'] });
  });
  it('a wide quote and stale figures give nothing', () => {
    expect(compositeReference({ bid: 50n, ask: 150n, lastTrade: { price: 100n, ts: 1n } }, rules)).toBeNull();
  });
  it('always lies between the lowest and highest qualifying source', () => {
    for (let i = 0; i < 200; i++) {
      const a = BigInt(1 + ((i * 7919) % 1000));
      const b = BigInt(1 + ((i * 104729) % 1000));
      const c = BigInt(1 + ((i * 1299709) % 1000));
      const r = compositeReference({ lastTrade: { price: a, ts: 999_999n }, valuation: { price: b, ts: 999_999n }, bid: c, ask: c }, rules)!;
      expect(r.price >= [a, b, c].reduce((x, y) => (x < y ? x : y))).toBe(true);
      expect(r.price <= [a, b, c].reduce((x, y) => (x > y ? x : y))).toBe(true);
    }
  });
});
