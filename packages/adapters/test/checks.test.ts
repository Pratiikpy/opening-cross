// The pre-flight checks mirror programs/cross_settle/src/design.rs and batch.rs. Each case below is one of that file's unit-test cases, run over the
// config the real builder produces from a design.
import { describe, expect, it } from 'vitest';
import { ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, MigratedCollectFeeMode, MigrationFeeOption, MigrationOption, TokenDecimal } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildContinuationConfig, checkBatchStart, checkBatchedPoolFee, checkLockedDesign, type ContinuationDesign } from '../src/index.js';

const base = (): ContinuationDesign => ({
  token: { tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, totalTokenSupply: 1_000_000_000, leftover: 5_000_000 },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 40,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.Compounding, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 100, compoundingFeeBps: 5000 },
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 30,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityVestingInfoParams: { vestingPercentage: 60, bpsPerPeriod: 2500, numberOfPeriods: 4, cliffDurationFromMigrationTime: 0, totalDuration: 4 * 86_400 },
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  sqrtPriceMultiples: [2, 4],
});
const codes = (d: ContinuationDesign) => checkLockedDesign(buildContinuationConfig(1_000_000n, 1_000_000n, d)).map((i) => i.code);

describe('checkLockedDesign (design::check_locked_design)', () => {
  it('accepts the designed config', () => expect(codes(base())).toEqual([]));

  it('refuses each departure with the program error name', () => {
    const d = (f: (x: ContinuationDesign) => void) => {
      const x = base();
      f(x);
      return x;
    };
    expect(codes(d((x) => void (x.migration.migratedPoolFee = { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 100, compoundingFeeBps: 0 })))).toContain('DesignNotCompounding');
    // creator liquidity unlocked: 5% unlocked, 60% vesting becomes 55% so the distribution still sums to 100
    expect(codes(d((x) => { x.liquidityDistribution.creatorLiquidityPercentage = 5; x.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 55; }))).toContain('DesignUnlockedLiquidity');
    expect(codes(d((x) => { x.liquidityDistribution.partnerLiquidityPercentage = 5; x.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 55; }))).toContain('DesignUnlockedLiquidity');
    // locked below 20%: 10 + 9, the rest vests
    expect(codes(d((x) => { x.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 10; x.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 9; x.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 81; }))).toContain('DesignLockTooLow');
    // the floor is inclusive
    expect(codes(d((x) => { x.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 10; x.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 10; x.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 80; }))).toEqual([]);
  });

  it('reports a design that departs in several ways with every issue, not the first', () => {
    const x = base();
    x.migration.migratedPoolFee = { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 100, compoundingFeeBps: 0 };
    x.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 5;
    x.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 5;
    x.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 90;
    const c = codes(x);
    expect(c).toEqual(expect.arrayContaining(['DesignNotCompounding', 'DesignLockTooLow']));
  });
});

describe('checkBatchStart (batch::check_batched_pool / check_batched_pair, window and start)', () => {
  const now = 1_000n;
  it('accepts a start exactly at the window and later', () => {
    expect(checkBatchStart({ now, windowSecs: 300, activationPoint: 1_300n })).toEqual([]);
    expect(checkBatchStart({ now, windowSecs: 300, activationPoint: 1_301n })).toEqual([]);
  });
  it('refuses a start before the window ends, no start, and a window out of range', () => {
    expect(checkBatchStart({ now, windowSecs: 300, activationPoint: 1_299n })[0]!.code).toBe('BatchActivation');
    expect(checkBatchStart({ now, windowSecs: 300, activationPoint: null })[0]!.code).toBe('BatchActivation');
    expect(checkBatchStart({ now, windowSecs: 29, activationPoint: 5_000n })[0]!.code).toBe('BatchWindow');
    expect(checkBatchStart({ now, windowSecs: 7 * 86_400 + 1, activationPoint: 10_000_000n })[0]!.code).toBe('BatchWindow');
    expect(checkBatchStart({ now, windowSecs: 30, activationPoint: 5_000n })).toEqual([]);
    expect(checkBatchStart({ now, windowSecs: 7 * 86_400, activationPoint: BigInt(7 * 86_400) + 1_000n })).toEqual([]);
  });
});

describe('checkBatchedPoolFee (the fee must decay on a timer)', () => {
  it('accepts a fee that steps down', () => {
    expect(checkBatchedPoolFee({ feeBps: 500, endingFeeBps: 100, periods: 10, periodSecs: 60 })).toEqual([]);
  });
  it('refuses a flat or rising fee, no periods, and no period length', () => {
    for (const f of [
      { feeBps: 100, endingFeeBps: 100, periods: 10, periodSecs: 60 },
      { feeBps: 100, endingFeeBps: 200, periods: 10, periodSecs: 60 },
      { feeBps: 500, endingFeeBps: 100, periods: 0, periodSecs: 60 },
      { feeBps: 500, endingFeeBps: 100, periods: 10, periodSecs: 0 },
      { feeBps: 500, endingFeeBps: 100, periods: 70_000, periodSecs: 60 },
    ]) {
      const issues = checkBatchedPoolFee(f);
      expect(issues.length, JSON.stringify(f)).toBeGreaterThan(0);
      expect(issues[0]!.code).toBe('BatchFeeNotDecaying');
    }
  });
});
