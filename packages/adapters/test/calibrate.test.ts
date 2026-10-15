import { describe, expect, it } from 'vitest';
import { CURVE_MAX_SEGMENTS, DEFAULT_CURVE_MULTIPLES, calibrateCurveFromDemand } from '../src/calibrate.js';

const P = 1_300_000n;
const bid = (price: number, quantity: number) => ({ price: BigInt(price), quantity: BigInt(quantity) });

describe('demand-calibrated curve segments', () => {
  it('puts more liquidity where more demand was revealed, and the band edges cover the highest limit', () => {
    const bids = [bid(1_400_000, 900), bid(1_450_000, 800), bid(1_500_000, 700), bid(1_900_000, 120), bid(2_600_000, 60), bid(1_000_000, 5_000)];
    const c = calibrateCurveFromDemand({ clearingPrice: P, bids, segments: 4 });
    expect(c.basis).toBe('demand');
    expect(c.sqrtPriceMultiples).toHaveLength(4);
    expect(c.liquidityWeights).toHaveLength(4);
    // Strictly increasing and above 1; the last edge reaches 20% over the highest limit (2,600,000 x 1.2).
    expect(c.sqrtPriceMultiples[0]! > 1).toBe(true);
    for (let i = 1; i < 4; i++) expect(c.sqrtPriceMultiples[i]! > c.sqrtPriceMultiples[i - 1]!).toBe(true);
    expect(c.bands[3]!.to >= 2_600_000n).toBe(true);
    expect(Math.abs(c.sqrtPriceMultiples[3]! ** 2 * Number(P) - 2_600_000 * 1.2) / (2_600_000 * 1.2)).toBeLessThan(1e-6);
    // The bid at or below P* (1,000,000 x 5,000) is not demand above the clearing price.
    expect(c.demandAbove).toBe(900n + 800n + 700n + 120n + 60n);
    // Every unit above P* is counted in exactly one band.
    expect(c.bands.reduce((n, b) => n + b.demand, 0n)).toBe(c.demandAbove);
    // The first band (up to about 1.54x of P*... in log steps) holds the heavy bids, so it weighs the most, and the far, thin bands the least.
    const w = c.liquidityWeights;
    expect(w[0]! > w[1]!).toBe(true);
    expect(Math.max(...w)).toBe(w[0]);
    expect(w.every((x) => x > 0)).toBe(true);
    // The weights average to 1.
    expect(Math.abs(w.reduce((a, b) => a + b, 0) / w.length - 1)).toBeLessThan(1e-3);
  });

  it('floors an empty band so the curve has no cliff', () => {
    const c = calibrateCurveFromDemand({ clearingPrice: P, bids: [bid(1_350_000, 1_000), bid(1_360_000, 1), bid(3_000_000, 1_000)], segments: 3, floorBps: 1_000 });
    expect(c.bands.some((b) => b.demand === 0n)).toBe(true);
    expect(c.liquidityWeights.every((x) => x > 0)).toBe(true);
    const empty = c.bands.findIndex((b) => b.demand === 0n);
    expect(c.liquidityWeights[empty]! < Math.min(...c.liquidityWeights.filter((_, i) => i !== empty).map((x) => x))).toBe(true);
  });

  it('says it has nothing to read when there is no demand above P*, and returns the default shape', () => {
    for (const bids of [[], [bid(1_000_000, 10)], [bid(1_400_000, 10), bid(1_400_000, 90)]]) {
      const c = calibrateCurveFromDemand({ clearingPrice: P, bids });
      expect(c.basis).toBe('default');
      expect(c.reason).toMatch(/no bid|only one/);
      expect(c.sqrtPriceMultiples).toEqual([...DEFAULT_CURVE_MULTIPLES]);
      expect(c.liquidityWeights).toEqual([1, 1, 1]);
    }
  });

  it('never makes more bands than there are distinct limits, and refuses bad inputs', () => {
    const three = [bid(1_400_000, 1), bid(1_500_000, 1), bid(1_600_000, 1)];
    expect(calibrateCurveFromDemand({ clearingPrice: P, bids: three, segments: 10 }).sqrtPriceMultiples).toHaveLength(3);
    expect(() => calibrateCurveFromDemand({ clearingPrice: P, bids: three, segments: 0 })).toThrow(/segments/);
    expect(() => calibrateCurveFromDemand({ clearingPrice: P, bids: three, segments: CURVE_MAX_SEGMENTS + 1 })).toThrow(/segments/);
    expect(() => calibrateCurveFromDemand({ clearingPrice: 0n, bids: three })).toThrow(/positive/);
    expect(() => calibrateCurveFromDemand({ clearingPrice: P, bids: [bid(1_400_000, -1)] })).toThrow(/negative/);
    expect(() => calibrateCurveFromDemand({ clearingPrice: P, bids: three, headroomBps: -1 })).toThrow(/headroom/);
  });

  it('is deterministic and independent of the order of the bids', () => {
    const bids = [bid(1_400_000, 3), bid(1_800_000, 9), bid(1_500_000, 4), bid(2_200_000, 1), bid(1_450_000, 8)];
    const a = calibrateCurveFromDemand({ clearingPrice: P, bids });
    const b = calibrateCurveFromDemand({ clearingPrice: P, bids: [...bids].reverse() });
    expect(a).toEqual(b);
  });

  it('close bands stay strictly increasing even when two edges are one price unit apart', () => {
    const c = calibrateCurveFromDemand({ clearingPrice: 10n, bids: [bid(11, 5), bid(12, 5)], segments: 6, headroomBps: 0 });
    for (let i = 1; i < c.sqrtPriceMultiples.length; i++) expect(c.sqrtPriceMultiples[i]! > c.sqrtPriceMultiples[i - 1]!).toBe(true);
    expect(c.sqrtPriceMultiples[0]! > 1).toBe(true);
  });
});
