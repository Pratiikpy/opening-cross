import { describe, expect, it } from 'vitest';
import { DEFAULT_VALUATION, type LiquidationPolicy, type Position, type Source, type Valuation, decide, fairValue } from '../src/index.js';

const NOW = 1_800_000_000;
const policy = (over: Partial<Parameters<typeof fairValue>[1]> = {}) => ({ ...DEFAULT_VALUATION, now: NOW, marketOpen: true, ...over });
const usd = (x: number) => BigInt(Math.round(x * 1e6));
const src = (kind: Source['kind'], price: number, ageSec = 10, extra: Partial<Source> = {}): Source => ({ kind, price: usd(price), at: NOW - ageSec, ...extra });

describe('fair value', () => {
  it('one guarded print gives a usable, ordered band around it', () => {
    const v = fairValue([src('cross-print', 200, 3_600, { guarded: true })], policy());
    expect(v.mid).toBe(usd(200));
    expect(v.lo <= v.mid && v.mid <= v.hi).toBe(true);
    expect(v.usable && v.guarded).toBe(true);
    expect(v.widthBps).toBeGreaterThanOrEqual(2 * DEFAULT_VALUATION.baseBandBps['cross-print'] - 2);
  });

  it('a closed market widens the band, and sources that disagree make it unusable instead of averaging them', () => {
    const open = fairValue([src('cross-print', 200, 100, { guarded: true })], policy());
    const closed = fairValue([src('cross-print', 200, 100, { guarded: true })], policy({ marketOpen: false }));
    expect(closed.widthBps).toBeGreaterThan(open.widthBps);
    const apart = fairValue([src('cross-print', 200, 100, { guarded: true }), src('reference', 215, 30)], policy());
    expect(apart.usable).toBe(false);
    expect(apart.reasons.join(' ')).toMatch(/disagree by 750 bps/);
  });

  it('ignores stale, future-dated and non-positive sources, and says so; nothing fresh means nothing usable', () => {
    const v = fairValue([src('oracle', 100, 500), src('reference', 0, 1), src('reference', 100, -50)], policy());
    expect(v.usable).toBe(false);
    expect(v.used).toEqual([]);
    expect(v.reasons.join(' ')).toMatch(/oracle: 500s old, limit 120s/);
    expect(v.reasons.join(' ')).toMatch(/non-positive/);
    expect(v.reasons.join(' ')).toMatch(/future/);
  });

  it('the median resists one wild source inside the disagreement limit and a source with a stated confidence widens the band', () => {
    const v = fairValue([src('oracle', 100, 5), src('reference', 100.3, 5), src('cross-print', 100.1, 100, { guarded: true })], policy());
    expect(v.usable).toBe(true);
    expect(Number(v.mid) / 1e6).toBeGreaterThan(99.9);
    expect(Number(v.mid) / 1e6).toBeLessThan(100.4);
    const wide = fairValue([src('oracle', 100, 5, { confidenceBps: 300, guarded: true })], policy());
    expect(wide.widthBps).toBeGreaterThanOrEqual(590);
  });

  it('is not guarded when the guarded source sits outside the band around the median', () => {
    const v = fairValue([src('oracle', 100, 5, { guarded: true }), src('reference', 103, 5), src('last-close', 103.2, 100)], policy({ disagreementBps: 1_000 }));
    expect(v.mid).toBe(usd(103));
    expect(v.guarded).toBe(false);
  });

  it('a band that reaches half the price says nothing', () => {
    const v = fairValue([src('oracle', 100, 5, { confidenceBps: 6_000 })], policy());
    expect(v.usable).toBe(false);
  });
});

describe('band-tied liquidation', () => {
  const pos: Position = { collateral: 10_000_000n, collateralDecimals: 6, debt: usd(700) }; // 10 tokens, 700 USD of debt
  const lp: LiquidationPolicy = { liquidationLtvBps: 8_500, bonusBps: 500, maxBandWidthBps: 600 };
  const valuation = (mid: number, halfBps: number, over: Partial<Valuation> = {}): Valuation => ({
    mid: usd(mid), lo: (usd(mid) * BigInt(10_000 - halfBps)) / 10_000n, hi: (usd(mid) * BigInt(10_000 + halfBps)) / 10_000n, widthBps: 2 * halfBps, usable: true, guarded: true, used: ['cross-print'], reasons: [], ...over,
  });

  it('holds a healthy position, liquidates one that breaches even at the favourable edge, and flags one that only the low edge breaches', () => {
    expect(decide(pos, valuation(100, 100), lp).action).toBe('hold'); // 700 / 1000 = 70%
    const liq = decide(pos, valuation(80, 100), lp); // 700 / 800 = 87.5% mid, 86.6% at the high edge
    expect(liq.action).toBe('liquidate');
    const risky = decide(pos, valuation(83, 200), lp); // mid 84.3%, low edge 86.0% >= 85%, high edge 82.6% < 85%
    expect(risky.action).toBe('hold');
    expect(risky.action === 'hold' && risky.atRisk).toBe(true);
    expect(risky.reasons.join(' ')).toMatch(/at risk/);
  });

  it('never acts on a valuation that is stale, unguarded, disagreeing or too wide: it waits', () => {
    const base = valuation(80, 100);
    for (const bad of [{ usable: false }, { guarded: false }, { widthBps: 700 }] as Partial<Valuation>[]) {
      const d = decide(pos, { ...base, ...bad }, lp);
      expect(d.action).toBe('wait');
    }
  });

  it('declares bad debt only when even the favourable edge, sold at the discount, cannot cover the debt', () => {
    const d = decide(pos, valuation(70, 100), lp); // value at hi = 10 x 70.7 = 707; discounted 671 < 700
    expect(d.action).toBe('insolvent');
    expect(decide(pos, valuation(75, 100), lp).action).toBe('liquidate'); // 757 x 0.95 = 719 >= 700
  });

  it('a position without debt is never touched, and a zero-value band cannot divide by zero', () => {
    expect(decide({ ...pos, debt: 0n }, valuation(1, 100), lp).action).toBe('hold');
    expect(decide(pos, { ...valuation(0, 0), mid: 0n, lo: 0n, hi: 0n }, lp).action).toBe('wait');
  });

  it('property: over thousands of random positions and valuations, an unusable, unguarded or too-wide valuation never liquidates', () => {
    let seed = 99;
    const rnd = (n: number) => ((seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0), (seed >>> 8) % n);
    let liquidations = 0;
    for (let i = 0; i < 20_000; i++) {
      const mid = 20 + rnd(400);
      const half = rnd(400);
      const v = valuation(mid, half, { usable: rnd(4) !== 0, guarded: rnd(4) !== 0 });
      const collateral = BigInt(1 + rnd(50)) * 1_000_000n;
      // Debt between 50% and 104% of the collateral's mid value, so every branch (hold, at risk, liquidate, insolvent) is reached.
      const p: Position = { collateral, collateralDecimals: 6, debt: (((collateral * usd(mid)) / 1_000_000n) * BigInt(50 + rnd(55))) / 100n };
      const d = decide(p, v, lp);
      if (d.action === 'liquidate') {
        liquidations++;
        expect(v.usable && v.guarded && v.widthBps <= lp.maxBandWidthBps).toBe(true);
        // and the position breaches the threshold even at the favourable edge, in exact integer arithmetic
        const hiValue = (p.collateral * v.hi) / 1_000_000n;
        expect(p.debt * 10_000n >= hiValue * BigInt(lp.liquidationLtvBps)).toBe(true);
      }
    }
    expect(liquidations).toBeGreaterThan(100); // the property was exercised, not vacuous
  });
});
