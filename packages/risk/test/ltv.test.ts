import { describe, expect, it } from 'vitest';
import { type Bar, DEFAULT_POLICY, UNITS, badDebtBps, classify, closureForHours, gapsOf, ltvFor, maxLtv, pooled, statsOf, summarise } from '../src/index.js';

const bar = (date: string, open: number, close: number): Bar => ({ date, open: Math.round(open * 1e6), high: Math.round(Math.max(open, close) * 1e6), low: Math.round(Math.min(open, close) * 1e6), close: Math.round(close * 1e6) });

describe('gaps from bars', () => {
  it('classifies overnight, weekend and holiday gaps and computes close-to-open returns in integer units', () => {
    const bars = [
      bar('2026-09-03', 100, 100), // Thursday
      bar('2026-09-04', 99, 100), // Friday: overnight, -1%
      bar('2026-09-08', 90, 95), // Tuesday after Labour Day (Monday 7 Sept): a 4-day gap, -10%
      bar('2026-09-09', 95, 96), // Wednesday: overnight, 0%
      bar('2026-09-14', 96, 97), // Monday after Friday? no: Wed to Mon is 5 days
    ];
    const gaps = gapsOf(bars);
    expect(gaps.map((g) => [g.closure, g.days, g.ret])).toEqual([
      ['overnight', 1, -10_000],
      ['long', 4, -100_000],
      ['overnight', 1, 0],
      ['long', 5, 0],
    ]);
    expect(classify(3)).toBe('weekend');
  });

  it('refuses data it cannot trust instead of guessing', () => {
    expect(() => gapsOf([bar('2026-01-02', 1, 1), bar('2026-01-01', 1, 1)])).toThrow(/out of order/);
    expect(() => gapsOf([bar('2026-01-01', 1, 1), { ...bar('2026-01-02', 1, 1), open: 0 }])).toThrow(/non-positive/);
  });

  it('summarises without keeping prices', () => {
    // Three Friday closes followed by Monday opens at -10%, +2% and -20%.
    const gaps = gapsOf([bar('2026-09-04', 100, 100), bar('2026-09-07', 90, 100), bar('2026-09-11', 100, 100), bar('2026-09-14', 102, 100), bar('2026-09-18', 100, 100), bar('2026-09-21', 80, 100)]);
    const weekendGaps = gaps.filter((g) => g.closure === 'weekend');
    expect(weekendGaps).toHaveLength(3);
    const s = summarise(statsOf(gaps, 'weekend'))!;
    expect(s.n).toBe(3);
    expect(s.worst).toBe(-200_000);
    expect(s.below.m10).toBe(1); // -20% is below -10%; exactly -10% is not
    expect(s.below.m20).toBe(0); // exactly -20% is not below -20%
    expect(JSON.stringify(s)).not.toMatch(/"from"|"to"/);
  });
});

describe('maximum LTV', () => {
  const calm = (n: number, loss = 0.03) => ({ closure: 'weekend' as const, n, mean: 0, stdev: 0, returns: Array.from({ length: n }, (_, i) => Math.round(-loss * UNITS * (1 - i / n))) });

  it('is (1 - covered loss) x (1 - bonus) - buffer, in basis points, capped', () => {
    // 600 observations certify alpha = 1% easily (rank 3 or so); the worst of them is -3%, but the policy assumes at least 10%.
    const r = maxLtv(calm(600), DEFAULT_POLICY);
    expect(r.certified).toBe(true);
    expect(r.coveredLossBps).toBe(1_000);
    expect(Math.floor((9_000 * 9_500) / 10_000) - 100).toBe(8_450); // the formula's value, above the 8,000 cap
    expect(r.ltvBps).toBe(8_000);
    const loose = maxLtv(calm(600), { ...DEFAULT_POLICY, capBps: 9_500, minLossBps: 0 });
    expect(loose.ltvBps).toBeLessThan(9_500);
    expect(loose.coveredLossBps).toBeGreaterThan(0);
    expect(loose.ltvBps).toBe(Math.floor(((10_000 - loose.coveredLossBps) * 9_500) / 10_000) - 100);
  });

  it('falls back to a stressed, capped, uncertified LTV when history is too short, and says why', () => {
    const r = maxLtv(calm(120, 0.2), DEFAULT_POLICY);
    expect(r.certified).toBe(false);
    expect(r.ltvBps).toBeLessThanOrEqual(4_000);
    expect(r.coveredLossBps).toBe(3_000); // 20% x 1.5
    expect(r.basis).toMatch(/only 120 weekend gaps; 299 are needed/);
    expect(maxLtv(calm(0), DEFAULT_POLICY)).toMatchObject({ certified: false, n: 0 });
  });

  it('a worse tail never raises the LTV', () => {
    let last = Infinity;
    for (const loss of [0.02, 0.08, 0.15, 0.25, 0.4, 0.7]) {
      const r = maxLtv(calm(1000, loss), { ...DEFAULT_POLICY, capBps: 9_500, minLossBps: 0 });
      expect(r.ltvBps).toBeLessThanOrEqual(last);
      last = r.ltvBps;
    }
    expect(last).toBeGreaterThanOrEqual(0);
  });

  it('a gap that wipes the collateral out gives zero, never a negative LTV', () => {
    expect(maxLtv(calm(1000, 1), DEFAULT_POLICY).ltvBps).toBe(0);
  });

  it('applies the shorter-closure limits inside a longer one, and picks the class from the hours the market stays shut', () => {
    expect(closureForHours(14)).toBe('overnight');
    expect(closureForHours(66)).toBe('weekend');
    expect(closureForHours(96)).toBe('long');
    const heavyOvernight = { closure: 'overnight' as const, n: 2500, mean: 0, stdev: 0, returns: Array.from({ length: 2500 }, (_, i) => (i < 20 ? -400_000 : 0)) };
    const r = ltvFor(66, { overnight: heavyOvernight, weekend: calm(600) });
    expect(r.closure).toBe('weekend');
    expect(r.ltvBps).toBeLessThan(maxLtv(calm(600)).ltvBps); // the overnight tail binds the weekend loan too
    expect(ltvFor(66, { weekend: calm(600) }).certified).toBe(false); // no overnight history at all: uncertified, low
  });

  it('pooling peers lets a short history certify, scaled by volatility, and is flagged', () => {
    const target = { closure: 'weekend' as const, n: 100, mean: 0, stdev: 20_000, returns: Array.from({ length: 100 }, (_, i) => -20_000 + i * 400).sort((a, b) => a - b) };
    const peer = { closure: 'weekend' as const, n: 400, mean: 0, stdev: 10_000, returns: Array.from({ length: 400 }, (_, i) => -10_000 + i * 50) };
    const p = pooled(target, [peer]);
    expect(p.n).toBe(500);
    expect(p.pooled).toBe(true);
    expect(p.returns[0]!).toBeLessThanOrEqual(target.returns[0]!);
    expect(maxLtv(p, DEFAULT_POLICY).certified).toBe(true);
    expect(maxLtv(target, DEFAULT_POLICY).certified).toBe(false);
  });
});

describe('bad debt test', () => {
  it('is exact at the boundary', () => {
    // LTV 85.5% and a liquidation discount of 5% survive exactly a 10% fall: 0.9 x 0.95 = 0.855.
    expect(badDebtBps(8_550, -100_000, 500)).toBe(0);
    expect(badDebtBps(8_551, -100_000, 500)).toBeGreaterThan(0);
    expect(badDebtBps(7_000, 50_000, 500)).toBe(0); // a gain is never bad debt
    expect(badDebtBps(8_000, -1_000_000, 500)).toBe(10_000); // total loss: the whole debt
  });
});
