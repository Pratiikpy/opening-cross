import { describe, expect, it } from 'vitest';
import { ActivationType, BaseFeeMode, CollectFeeMode, MigrationFeeOption, MigrationOption, TokenDecimal } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildContinuationConfig, isqrt, sqrtPriceQ64 } from '../src/index.js';

describe('isqrt', () => {
  it('is the floor square root', () => {
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 2_000; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 192n) - 1n);
      const n = x >> BigInt(i % 190);
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect([0n, 1n, 2n, 3n, 4n].map(isqrt)).toEqual([0n, 1n, 1n, 1n, 2n]);
  });

  it('matches the program on known values', () => {
    expect(sqrtPriceQ64(1n, 1n)).toBe(1n << 64n);
    expect(sqrtPriceQ64(4n, 1n)).toBe(2n << 64n);
    expect(() => sqrtPriceQ64(1n, 0n)).toThrow();
  });
});

describe('buildContinuationConfig', () => {
  const design = {
    token: { tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear as const, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    sqrtPriceMultiples: [2, 4],
  };

  it('starts the curve exactly at the clearing price, with partner mint authority', () => {
    for (const p of [1_000_000n, 1_234_567n, 5_000_000n]) {
      const c = buildContinuationConfig(p, 1_000_000n, design);
      expect(BigInt(c.sqrtStartPrice.toString())).toBe(sqrtPriceQ64(p, 1_000_000n));
      expect(c.tokenUpdateAuthority).toBe(4);
      expect(c.tokenType).toBe(1);
    }
  });

  it('rejects curve multiples that do not rise', () => {
    expect(() => buildContinuationConfig(1_000_000n, 1_000_000n, { ...design, sqrtPriceMultiples: [2, 2] })).toThrow();
    expect(() => buildContinuationConfig(1_000_000n, 1_000_000n, { ...design, sqrtPriceMultiples: [0.5] })).toThrow();
  });
});
