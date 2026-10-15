// K2 tokenized-weekend measurement: closures found in hourly bars, the token's prices around them, and the statistics, on bars built so every answer is known in advance.
import { describe, expect, it } from 'vitest';
import { type HourBar, breaches, tracking, underwaterMove, weekendObservations } from '../src/index.js';

const H = 3600;
// Friday 2026-10-09 and Monday 2026-10-12, regular hours 13:30 to 19:30 UTC (EDT).
const FRI = Date.UTC(2026, 9, 9, 0) / 1000;
const MON = Date.UTC(2026, 9, 12, 0) / 1000;
const dateOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

const session = (day: number, open: number, last: number, hours = 7): HourBar[] => Array.from({ length: hours }, (_, i) => ({ t: day + 13 * H + 1800 + i * H, o: i === 0 ? open : last, h: Math.max(open, last), l: Math.min(open, last), c: last }));
/** Token bars from Friday 19:00 UTC to Monday 14:00 UTC at a flat price, with chosen overrides. */
const tokenFlat = (price: number, over: Record<number, Partial<HourBar>> = {}, skip: (t: number) => boolean = () => false): HourBar[] => {
  const out: HourBar[] = [];
  for (let t = FRI + 15 * H; t <= MON + 14 * H; t += H) if (!skip(t)) out.push({ t, o: price, h: price, l: price, c: price, ...over[t] });
  return out;
};

describe('weekendObservations', () => {
  const under = [...session(FRI, 99, 100), ...session(MON, 103, 104)];

  it('finds the closure and the token prices at the close and at the last hour before the open', () => {
    const token = tokenFlat(101, { [MON + 12 * H]: { c: 104 }, [FRI + 19 * H]: { c: 101 } });
    const [o] = weekendObservations('XYZx', token, under, dateOf);
    expect(o).toBeDefined();
    expect(o).toMatchObject({ symbol: 'XYZx', date: '2026-10-12', friday: 100, monday: 103, closeT: FRI + 20 * H, openT: MON + 13 * H + 1800, tokenClose: 101, tokenPreOpen: 104 });
    expect(o!.coverage).toBeGreaterThan(0.9);
  });

  it('records the lowest and highest price the token traded between the close and the pre-open print', () => {
    const token = tokenFlat(101, { [FRI + 30 * H]: { l: 80, h: 101 }, [FRI + 40 * H]: { h: 130, l: 101 }, [MON + 12 * H]: { c: 104 } });
    const [o] = weekendObservations('XYZx', token, under, dateOf);
    expect(o).toMatchObject({ tokenLow: 80, tokenHigh: 130 });
  });

  it('carries a price forward at most twelve hours and counts hours with no trade against coverage', () => {
    const quiet = tokenFlat(101, { [MON + 12 * H]: { c: 104 } }, (t) => t >= FRI + 22 * H && t < MON + 12 * H && (t - FRI) % (2 * H) === 0);
    const [o] = weekendObservations('XYZx', quiet, under, dateOf);
    expect(o!.coverage).toBeLessThan(0.6);
    // No token bar within twelve hours of the open: the closure is skipped, not guessed.
    const dead = tokenFlat(101, {}, (t) => t > FRI + 24 * H);
    expect(weekendObservations('XYZx', dead, under, dateOf)).toEqual([]);
  });

  it('ignores overnight breaks and sessions too far apart, and rounds an early close up to the hour', () => {
    const tue = MON + 86_400;
    const overnight = [...session(MON, 100, 101), ...session(tue, 101, 102)];
    expect(weekendObservations('XYZx', tokenFlat(100), overnight, dateOf)).toEqual([]);
    const early = [...session(FRI, 99, 100, 4), ...session(MON, 103, 104)]; // last bar starts 16:30 UTC and the session ends at 17:00
    const [o] = weekendObservations('XYZx', tokenFlat(101), early, dateOf);
    expect(o!.closeT).toBe(FRI + 17 * H);
    const far = [...session(FRI, 99, 100), ...session(FRI + 6 * 86_400, 103, 104)];
    expect(weekendObservations('XYZx', tokenFlat(101), far, dateOf)).toEqual([]);
  });
});

describe('tracking', () => {
  const obs = (friday: number, monday: number, tokenClose: number, tokenPreOpen: number) => ({ symbol: 'X', date: 'd', friday, monday, closeT: 0, openT: 1, tokenClose, tokenPreOpen, tokenLow: Math.min(tokenClose, tokenPreOpen), tokenHigh: Math.max(tokenClose, tokenPreOpen), coverage: 1, preOpenStaleHours: 0 });

  it('scores the token-implied Monday open against doing nothing, with the numbers worked out', () => {
    // Friday 100, token 101 -> 104 (+2.97%), Monday opens at 103: implied 100 x 104/101 = 102.970, error 0.0287%, naive 2.91%.
    const t = tracking([obs(100, 103, 101, 104)]);
    expect(t.closeBasisMedianBps).toBeCloseTo(100, 6);
    expect(t.tokenImpliedErrorMedianBps).toBeCloseTo(((103 - (100 * 104) / 101) / 103) * 10_000, 6);
    expect(t.naiveErrorMedianBps).toBeCloseTo((3 / 103) * 10_000, 6);
    expect(t.tokenBeatsNaive).toBe(1);
    expect(t.directionAgreement).toEqual({ n: 1, share: 1 });
    expect(t.slope).toBeNull(); // one point has no slope
  });

  it('is exact on a perfect predictor: slope 1, R-squared 1, error zero', () => {
    const rows = [[100, 103], [100, 98], [100, 101], [100, 95], [100, 107]].map(([f, m]) => obs(f!, m!, 50, (50 * m!) / f!));
    const t = tracking(rows);
    expect(t.slope).toBeCloseTo(1, 9);
    expect(t.rSquared).toBeCloseTo(1, 9);
    expect(t.tokenImpliedErrorMedianBps).toBeCloseTo(0, 6);
    expect(t.directionAgreement).toEqual({ n: 5, share: 1 });
  });

  it('shows when the token is worse than doing nothing, and counts only gaps of at least 50 bps for direction', () => {
    const t = tracking([obs(100, 100.2, 100, 110), obs(100, 100.1, 100, 90), obs(100, 95, 100, 105)]);
    expect(t.tokenBeatsNaive).toBe(0);
    expect(t.directionAgreement).toEqual({ n: 1, share: 0 });
  });
});

describe('breaches', () => {
  const obs = (g: number, pre: number, low: number, date: string) => ({ symbol: 'X', date, friday: 100, monday: 100 * (1 + g), closeT: 0, openT: 1, tokenClose: 100, tokenPreOpen: 100 * (1 + pre), tokenLow: 100 * (1 + low), tokenHigh: 100, coverage: 1, preOpenStaleHours: 0 });

  it('puts the underwater line at ltv / (1 - bonus) - 1: an 80% loan with a 5% discount is underwater below -15.79%', () => {
    expect(underwaterMove(8_000, 500)).toBeCloseTo(-0.157894736, 8);
    expect(underwaterMove(5_000, 500)).toBeCloseTo(-0.473684, 5);
  });

  it('counts a gap, a pre-open print and a weekend low separately, and uses the loan the engine set for that weekend', () => {
    const rows = [obs(-0.2, -0.1, -0.25, 'a'), obs(-0.05, -0.2, -0.3, 'b'), obs(0.01, 0.01, -0.17, 'c'), obs(0, 0, -0.5, 'unpriced')];
    const b = breaches(rows, new Map([['a', 8_000], ['b', 8_000], ['c', 8_000]]), 500);
    expect(b).toMatchObject({ n: 3, gapBreaches: 1, preOpenBreaches: 1, weekendLowBreaches: 3, meanLtvBps: 8_000 });
    expect(b.worstTokenDrawdownBps).toBeCloseTo(-3_000, 6);
    expect(b.worstGapBps).toBeCloseTo(-2_000, 6);
  });
});
