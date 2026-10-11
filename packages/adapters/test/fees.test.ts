import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { BaseFeeMode, getDynamicFeeParams, getVariableFeeNumerator, bpsToFeeNumerator } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildContinuationConfig, dynamicFeeBps, dynamicFeeNumerator, maxDynamicFeeBps, volatilityFeeParams, type ContinuationDesign } from '../src/index.js';

describe('volatilityFeeParams', () => {
  it('reproduces the SDK helper when asked for its own convention (20% of the base fee)', () => {
    for (const [baseFeeBps, move] of [[100, 1500], [50, 1500], [200, 800], [30, 300]] as const) {
      const mine = volatilityFeeParams({ baseFeeBps, extraFeeShareOfBase: 0.2, maxPriceChangeBps: move });
      const sdk = getDynamicFeeParams(baseFeeBps, move);
      expect(mine).toEqual(sdk);
    }
  });

  it('reaches the chosen share of the base fee at the cap, and never more', () => {
    for (const share of [0.2, 0.5, 1]) {
      const p = volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: share, maxPriceChangeBps: 1500 });
      const max = maxDynamicFeeBps(p);
      expect(max).toBeLessThanOrEqual(100 * share + 1e-6);
      expect(max).toBeGreaterThan(100 * share * 0.99);
    }
  });

  it('is zero when nothing has moved, rises with volatility and stops at the cap', () => {
    const p = volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1000 });
    expect(dynamicFeeNumerator(p, 0)).toBe(0n);
    let prev = 0n;
    for (let va = 0; va <= p.maxVolatilityAccumulator; va += Math.ceil(p.maxVolatilityAccumulator / 25)) {
      const f = dynamicFeeNumerator(p, va);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(dynamicFeeNumerator(p, p.maxVolatilityAccumulator * 10)).toBe(dynamicFeeNumerator(p, p.maxVolatilityAccumulator));
  });

  it('matches the SDK fee model at every accumulator reading', () => {
    const p = volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1500 });
    const config = { binStep: p.binStep, binStepU128: p.binStepU128, filterPeriod: p.filterPeriod, decayPeriod: p.decayPeriod, reductionFactor: p.reductionFactor, maxVolatilityAccumulator: p.maxVolatilityAccumulator, variableFeeControl: p.variableFeeControl };
    for (const va of [0, 1, 999, 10_000, 55_555, 250_000, p.maxVolatilityAccumulator]) {
      const tracker = { volatilityAccumulator: new BN(va), volatilityReference: new BN(0), lastUpdateTimestamp: new BN(0), padding: [] } as never;
      const sdk = getVariableFeeNumerator(config as never, tracker);
      expect(dynamicFeeNumerator(p, va).toString(), `va=${va}`).toBe(sdk.toString());
    }
  });

  it('refuses designs the chain cannot express or that break the fee cap', () => {
    const ok = { baseFeeBps: 100, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1500 };
    expect(() => volatilityFeeParams({ ...ok, baseFeeBps: 0 })).toThrow(/positive/);
    expect(() => volatilityFeeParams({ ...ok, maxPriceChangeBps: 1501 })).toThrow(/maxPriceChangeBps/);
    expect(() => volatilityFeeParams({ ...ok, maxPriceChangeBps: 0 })).toThrow(/maxPriceChangeBps/);
    expect(() => volatilityFeeParams({ ...ok, filterPeriodSeconds: 120, decayPeriodSeconds: 120 })).toThrow(/below decayPeriod/);
    expect(() => volatilityFeeParams({ ...ok, reductionFactorBps: 10_001 })).toThrow(/reductionFactorBps/);
    expect(() => volatilityFeeParams({ ...ok, baseFeeBps: 6000, extraFeeShareOfBase: 0.9 })).toThrow(/99%/);
    // A huge share on a tiny move needs a variable fee control above the 24-bit limit; the error says what would fit.
    expect(() => volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: 50, maxPriceChangeBps: 10 })).toThrow(/largest extra fee/);
  });

  it('keeps the total fee inside 99% even at the cap', () => {
    const p = volatilityFeeParams({ baseFeeBps: 5000, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1500 });
    expect(Number(bpsToFeeNumerator(5000)) + Number(dynamicFeeNumerator(p, p.maxVolatilityAccumulator))).toBeLessThanOrEqual(990_000_000);
    expect(dynamicFeeBps(p, p.maxVolatilityAccumulator)).toBeLessThanOrEqual(2500.0001);
  });
});

describe('the continuation config carries the design', () => {
  const design: ContinuationDesign = {
    token: { tokenBaseDecimal: 6, tokenQuoteDecimal: 6, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: true,
      collectFeeMode: 0,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: 1, migrationFeeOption: 2, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1,
    sqrtPriceMultiples: [2, 4],
  };

  it('uses the SDK default when no explicit parameters are given', () => {
    const c = buildContinuationConfig(1_000_000n, 1_000_000n, design);
    expect(c.poolFees.dynamicFee?.variableFeeControl).toBeGreaterThan(0);
    expect(Number(c.poolFees.dynamicFee?.maxVolatilityAccumulator)).toBeGreaterThan(0);
  });

  it('replaces the dynamic fee with the explicit design', () => {
    const dynamicFee = volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1500 });
    const c = buildContinuationConfig(1_000_000n, 1_000_000n, { ...design, dynamicFee });
    expect(c.poolFees.dynamicFee).toEqual(dynamicFee);
    expect(maxDynamicFeeBps(c.poolFees.dynamicFee!)).toBeGreaterThan(40);
  });

  it('refuses explicit parameters on a design that has dynamic fees switched off', () => {
    const dynamicFee = volatilityFeeParams({ baseFeeBps: 100, extraFeeShareOfBase: 0.5, maxPriceChangeBps: 1500 });
    expect(() => buildContinuationConfig(1_000_000n, 1_000_000n, { ...design, fee: { ...design.fee, dynamicFeeEnabled: false }, dynamicFee })).toThrow(/dynamicFeeEnabled/);
  });
});
