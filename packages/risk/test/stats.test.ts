import { describe, expect, it } from 'vitest';
import { binomialCdf, certifiedRank, minimumSample, quantile, sorted } from '../src/index.js';

describe('order statistics', () => {
  it('nearest-rank quantile', () => {
    const xs = sorted([5, 1, 9, 3, 7, 2, 8, 4, 6, 10]);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 0.1)).toBe(1);
    expect(quantile(xs, 0.11)).toBe(2);
    expect(quantile(xs, 0.5)).toBe(5);
    expect(quantile(xs, 1)).toBe(10);
    expect(() => quantile([], 0.5)).toThrow();
    expect(() => quantile(xs, 1.1)).toThrow();
  });

  it('binomial cdf matches exact values', () => {
    expect(binomialCdf(10, 0.5, 5)).toBeCloseTo(0.623046875, 12);
    expect(binomialCdf(10, 0.5, 0)).toBeCloseTo(1 / 1024, 12);
    expect(binomialCdf(10, 0.5, 10)).toBe(1);
    expect(binomialCdf(520, 0.01, 2)).toBeCloseTo(0.1075910847613345, 10); // summed independently in Python with exact integer binomial coefficients
    expect(binomialCdf(5, 0, 0)).toBe(1);
    expect(binomialCdf(5, 1, 4)).toBe(0);
  });
});

describe('distribution-free tolerance bound', () => {
  it('the minimum observation certifies alpha only from n = ln(1-c)/ln(1-alpha)', () => {
    expect(minimumSample(0.005, 0.95)).toBe(598);
    expect(certifiedRank(598, 0.005, 0.95)).toBe(1);
    expect(certifiedRank(597, 0.005, 0.95)).toBeNull();
    expect(minimumSample(0.01, 0.95)).toBe(299);
    expect(certifiedRank(299, 0.01, 0.95)).toBe(1);
    expect(certifiedRank(298, 0.01, 0.95)).toBeNull();
  });

  it('a larger sample certifies a less extreme order statistic, never a more extreme one', () => {
    let last = 0;
    for (const n of [300, 500, 1000, 2500, 5000, 20_000]) {
      const j = certifiedRank(n, 0.01, 0.95)!;
      expect(j).toBeGreaterThanOrEqual(last);
      last = j;
    }
    expect(certifiedRank(2500, 0.005, 0.95)).toBeGreaterThan(1);
  });

  it('the stated confidence is really reached by the chosen rank, and the next rank would not reach it', () => {
    for (const [n, a] of [[480, 0.01], [2400, 0.005], [150, 0.03], [1000, 0.001]] as const) {
      const j = certifiedRank(n, a, 0.95);
      if (j === null) continue;
      expect(1 - binomialCdf(n, a, j - 1)).toBeGreaterThanOrEqual(0.95);
      expect(1 - binomialCdf(n, a, j)).toBeLessThan(0.95);
    }
  });

  // The property that makes the rule worth having, tested against distributions whose tails we know exactly: whatever the tail,
  // in at least 95% of independent histories the certified order statistic has true probability mass <= alpha below it.
  for (const [name, cdf, inverse] of [
    ['Laplace', (x: number) => (x < 0 ? 0.5 * Math.exp(x) : 1 - 0.5 * Math.exp(-x)), (u: number) => (u < 0.5 ? Math.log(2 * u) : -Math.log(2 * (1 - u)))],
    ['Cauchy (infinite variance)', (x: number) => 0.5 + Math.atan(x) / Math.PI, (u: number) => Math.tan(Math.PI * (u - 0.5))],
    ['logistic', (x: number) => 1 / (1 + Math.exp(-x)), (u: number) => Math.log(u / (1 - u))],
  ] as const) {
    it(`coverage holds for ${name} returns`, () => {
      let seed = 12345;
      const rand = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0), (seed + 0.5) / 4_294_967_296);
      const trials = 1500;
      for (const [n, alpha] of [[300, 0.01], [520, 0.01], [2500, 0.005]] as const) {
        const j = certifiedRank(n, alpha, 0.95)!;
        let covered = 0;
        for (let t = 0; t < trials; t++) {
          const xs = Array.from({ length: n }, () => inverse(rand())).sort((a, b) => a - b);
          if (cdf(xs[j - 1]!) <= alpha) covered++;
        }
        // 1500 trials: the standard error of the coverage is about 0.6%.
        expect(covered / trials, `${name} n=${n} alpha=${alpha} rank=${j}`).toBeGreaterThanOrEqual(0.93);
      }
    }, 120_000);
  }
});
