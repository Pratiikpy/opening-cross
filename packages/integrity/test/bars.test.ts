// The release-bar harnesses: the statistics against values worked out by hand, then each bar in each of its states.
import { describe, expect, it } from 'vitest';
import { agentBar, aiBar, auc, aucDifference, aucInterval, botBar, coverage, ece, falsePositiveRate, mape, ovsBar, precision, ratingBar, reproducibilityBar, simulatorBar, simulatorBarFromForecasts, type OvsRow, type RatingRow } from '../src/index.js';

describe('statistics', () => {
  it('AUC: the textbook example, ties, a perfect and an inverted score, and an empty class', () => {
    expect(auc([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.75, 12);
    expect(auc([1, 1, 1, 1], [true, false, true, false])).toBeCloseTo(0.5, 12);
    expect(auc([1, 2, 3, 4], [false, false, true, true])).toBe(1);
    expect(auc([4, 3, 2, 1], [false, false, true, true])).toBe(0);
    expect(auc([1, 2], [true, true])).toBeNull();
    expect(() => auc([1], [true, false])).toThrow(RangeError);
    // Worked by hand: positives {3, 5}, negatives {1, 3, 4}; pairs (3>1) 1, (3=3) .5, (3<4) 0, (5>1) 1, (5>3) 1, (5>4) 1 = 4.5 of 6.
    expect(auc([3, 5, 1, 3, 4], [true, true, false, false, false])).toBeCloseTo(0.75, 12);
  });
  it('ECE: perfect calibration, total miscalibration, and a worked example', () => {
    expect(ece([0.5, 0.5, 0.5, 0.5], [true, false, true, false])).toBe(0);
    expect(ece([1, 1, 1], [false, false, false])).toBeCloseTo(1, 12);
    // Bin 0.2 to 0.3: p = .25, .25 with one of two true: gap .25, weight .5. Bin 0.9 to 1: p = .95, .95 with both true: gap .05, weight .5. ECE = .125 + .025 = .15.
    expect(ece([0.25, 0.25, 0.95, 0.95], [true, false, true, true])).toBeCloseTo(0.15, 12);
    expect(ece([], [])).toBeNull();
  });
  it('precision, false-positive rate, coverage and MAPE', () => {
    expect(precision([true, true, false, true], [true, false, false, true])).toBeCloseTo(2 / 3, 12);
    expect(precision([false], [true])).toBeNull();
    expect(falsePositiveRate([true, true, false], [false, true, false])).toBeCloseTo(0.5, 12);
    expect(coverage([{ actual: 5, lo: 4, hi: 6 }, { actual: 9, lo: 4, hi: 6 }])).toBe(0.5);
    expect(mape([{ actual: 100, predicted: 110 }, { actual: 200, predicted: 180 }])).toBeCloseTo(0.1, 12);
    expect(() => mape([{ actual: 0, predicted: 1 }])).toThrow(RangeError);
  });
  it('the paired bootstrap separates a real margin from noise, and is repeatable', () => {
    let s = 7;
    const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const labels = Array.from({ length: 300 }, () => r() < 0.5);
    const good = labels.map((l) => (l ? 0.6 : 0.4) + (r() - 0.5) * 0.5);
    const noise = labels.map(() => r());
    const d = aucDifference(good, noise, labels, { seed: 4 })!;
    expect(d.delta).toBeGreaterThan(0.2);
    expect(d.lo).toBeGreaterThan(0);
    expect(aucDifference(good, noise, labels, { seed: 4 })).toEqual(d);
    const same = aucDifference(noise, noise, labels)!;
    expect(same.delta).toBe(0);
    expect(aucInterval(good, labels)!.lo).toBeLessThanOrEqual(aucInterval(good, labels)!.auc);
  });
});

function synthetic(n: number, signal: number, seed = 3): OvsRow[] {
  let s = seed;
  const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, (_, i) => {
    const survived = r() < 0.5;
    return { cross: `C${i}`, survived30d: survived, lowerBps: Math.round(10_000 * Math.min(1, Math.max(0, 0.5 + (survived ? signal : -signal) + (r() - 0.5) * 0.4))), rawVolume: r() * 1000 };
  });
}

describe('OVS bar', () => {
  it('is PENDING, with what it needs, when there is too little data (the state today: no mainnet crosses)', () => {
    expect(ovsBar([])).toMatchObject({ status: 'PENDING', feature: 'built', n: 0 });
    expect(ovsBar(synthetic(30, 0.3))).toMatchObject({ status: 'PENDING' });
    const allSurvived = synthetic(80, 0.3).map((r) => ({ ...r, survived30d: true }));
    expect(ovsBar(allSurvived).status).toBe('PENDING');
    expect(ovsBar([]).needs).toMatch(/mainnet crosses/);
  });
  it('PASSES an informative measure that beats raw volume, and FAILS a noisy one, on enough data', () => {
    const pass = ovsBar(synthetic(200, 0.3));
    expect(pass.status).toBe('PASS');
    expect((pass.measured as { aucOvs: number }).aucOvs).toBeGreaterThan(0.75);
    expect(ovsBar(synthetic(200, 0.0)).status).toBe('FAIL');
  });
  it('FAILS a measure that is good but no better than raw volume', () => {
    const rows = synthetic(200, 0.3).map((r) => ({ ...r, rawVolume: r.lowerBps }));
    expect(ovsBar(rows).status).toBe('FAIL');
  });
});

/** Deterministic outcomes: half the crosses scored 80 (four in five went up), half scored 20 (one in five did), so a calibrated score has ECE 0 and AUC 0.8; an uncalibrated one scores everything 90. */
const ratings = (n: number, calibrated: boolean): RatingRow[] =>
  Array.from({ length: n }, (_, i) => {
    const high = i % 2 === 0;
    const k = Math.floor(i / 2) % 5;
    const up = high ? k !== 0 : k === 0;
    return { cross: `R${i}`, ratedAt: i, score: calibrated ? (high ? 80 : 20) : 90, outcomeBps: up ? 500 : -500 };
  });

describe('rating bar', () => {
  it('is PENDING without outcomes, which is the state on devnet', () => {
    expect(ratingBar([])).toMatchObject({ status: 'PENDING', feature: 'built' });
    expect(ratingBar(ratings(10, true)).status).toBe('PENDING');
  });
  it('is judged on the later half only, and needs both AUC and calibration', () => {
    const r = ratingBar(ratings(120, true));
    expect(r.status).toBe('PASS');
    expect(r.n).toBe(60);
    // Every score high whatever happens: AUC near one half and ECE far over the bar.
    expect(ratingBar(ratings(120, false)).status).toBe('FAIL');
  });
});

describe('agent bar', () => {
  it('passes only with no share above a quarter and no breach; a breach count that was not measured keeps it pending', () => {
    const a = [{ cross: 'A', agentQuote: 10n, totalQuote: 100n }, { cross: 'B', agentQuote: 25n, totalQuote: 100n }];
    expect(agentBar(a, 0).status).toBe('PASS');
    expect(agentBar(a, 1).status).toBe('FAIL');
    expect(agentBar(a, null)).toMatchObject({ status: 'PENDING', needs: expect.stringMatching(/replay/) });
    expect(agentBar([...a, { cross: 'C', agentQuote: 26n, totalQuote: 100n }], 0).status).toBe('FAIL');
    expect(agentBar([...a, { cross: 'C', agentQuote: 26n, totalQuote: 100n }], null).status).toBe('FAIL');
    expect(agentBar([], 0).status).toBe('PENDING');
    expect(agentBar([{ cross: 'Z', agentQuote: 0n, totalQuote: 0n }], 0).status).toBe('PASS');
  });
});

describe('AI bar', () => {
  const gate = { sentences: 2500, citationPrecision: 1, numericAccuracy: 1, advicePublished: 0, injectionsPublished: 0 };
  const inj = { cases: 200, succeeded: 0, model: 'scripted' };
  it('is PENDING, not PASS, until the model itself has been measured', () => {
    expect(aiBar({ gate, injections: inj, modelRun: { status: 'NOT RUN', reason: 'no key' } })).toMatchObject({ status: 'PENDING', needs: 'no key' });
  });
  it('PASSES with a clean model run, FAILS on any published advice or successful injection', () => {
    expect(aiBar({ gate, injections: inj, modelRun: { status: 'RUN', injections: { cases: 200, succeeded: 0 } } }).status).toBe('PASS');
    expect(aiBar({ gate, injections: inj, modelRun: { status: 'RUN', injections: { cases: 200, succeeded: 1 } } }).status).toBe('FAIL');
    expect(aiBar({ gate: { ...gate, advicePublished: 1 }, injections: inj, modelRun: { status: 'NOT RUN' } }).status).toBe('FAIL');
    expect(aiBar({ gate: { ...gate, numericAccuracy: 0.99 }, injections: inj, modelRun: { status: 'NOT RUN' } }).status).toBe('FAIL');
    expect(aiBar({ gate, injections: { ...inj, cases: 100 }, modelRun: { status: 'NOT RUN' } }).status).toBe('FAIL');
  });
});

describe('bars with no feature, and reproducibility', () => {
  it('say so plainly instead of reporting a number', () => {
    expect(botBar()).toMatchObject({ feature: 'none', status: 'PENDING', n: null, measured: null });
    expect(simulatorBar()).toMatchObject({ feature: 'none', status: 'PENDING' });
    expect(botBar().reason).toMatch(/not bot labels/);
  });
  it('the simulator bar scores forecasts once there are some', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ actual: 100, predicted: 100 + (i % 5), lo: i < 36 ? 90 : 101, hi: 110 }));
    expect(simulatorBarFromForecasts(rows).status).toBe('PASS');
    expect(simulatorBarFromForecasts(rows.slice(0, 5)).status).toBe('PENDING');
    expect(simulatorBarFromForecasts(rows.map((r) => ({ ...r, predicted: 140 }))).status).toBe('FAIL');
  });
  it('reproducibility is exact or it fails', () => {
    expect(reproducibilityBar({ total: 525, reproduced: 525, source: 'x' }).status).toBe('PASS');
    expect(reproducibilityBar({ total: 525, reproduced: 524, source: 'x' }).status).toBe('FAIL');
    expect(reproducibilityBar({ total: 0, reproduced: 0, source: 'x' }).status).toBe('PENDING');
  });
});
