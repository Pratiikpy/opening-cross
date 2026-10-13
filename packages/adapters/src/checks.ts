// Pre-flight checks that mirror what the cross_settle program refuses (programs/cross_settle/src/design.rs and batch.rs), so a caller reads a reason
// before it signs instead of a program error after. The program stays the authority: every function here is the same rule over the same inputs, and
// each `code` is the name of the `SettleError` the program would raise.
import { BaseFeeMode, getBaseFeeParams } from '@meteora-ag/cp-amm-sdk';
import type { ConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk';

export type DesignIssue = { code: string; field: string; message: string };

/** The shortest and longest batch window the program accepts (`batch::MIN_WINDOW_SECS`, `MAX_WINDOW_SECS`). */
export const MIN_BATCH_WINDOW_SECS = 30;
export const MAX_BATCH_WINDOW_SECS = 7 * 24 * 60 * 60;
/** At least this share of the migration liquidity must be locked for good (`design::MIN_PERMANENT_LOCK_PCT`). */
export const MIN_PERMANENT_LOCK_PCT = 20;

const MIGRATION_OPTION_DAMM_V2 = 1;
const COLLECT_FEE_MODE_COMPOUNDING = 2;
const num = (v: unknown): number => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v));

/**
 * `design::check_locked_design`: the DBC config `open_dbc_pool_locked` accepts. Returns every departure, not only the first, so a form can show them all.
 * An empty list means the program's design check would pass (the program also checks the start price, the token type and the authority option, which
 * `buildContinuationConfig` sets itself).
 */
export function checkLockedDesign(c: ConfigParameters): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message });
  if (num(c.migrationOption) !== MIGRATION_OPTION_DAMM_V2) add('DesignMigration', 'migration.migrationOption', 'The locked design migrates into DAMM v2.');
  const compounding = num(c.compoundingFeeBps);
  if (num(c.migratedPoolFee.collectFeeMode) !== COLLECT_FEE_MODE_COMPOUNDING || compounding <= 0 || compounding > 10_000) {
    add('DesignNotCompounding', 'migration.migratedPoolFee.collectFeeMode', 'The migrated pool must collect fees in the compounding mode, with a compounding fee between 1 and 10,000 bps.');
  }
  if (num(c.partnerLiquidityPercentage) !== 0 || num(c.creatorLiquidityPercentage) !== 0) {
    add('DesignUnlockedLiquidity', 'liquidityDistribution', 'No liquidity may be withdrawable the moment the pool migrates: partnerLiquidityPercentage and creatorLiquidityPercentage must be 0.');
  }
  if (num(c.partnerLiquidityVestingInfo.vestingPercentage) !== 0) {
    add('DesignPartnerVesting', 'partnerLiquidityVestingInfo', 'The protocol-owned position cannot vest liquidity; partner liquidity may only be locked permanently.');
  }
  const locked = num(c.partnerPermanentLockedLiquidityPercentage) + num(c.creatorPermanentLockedLiquidityPercentage);
  if (locked < MIN_PERMANENT_LOCK_PCT) {
    add('DesignLockTooLow', 'liquidityDistribution', `At least ${MIN_PERMANENT_LOCK_PCT}% of the migration liquidity must be locked permanently across both sides; this design locks ${locked}%.`);
  }
  const v = c.creatorLiquidityVestingInfo;
  if (num(v.vestingPercentage) > 0 && !(num(v.numberOfPeriods) > 0 && num(v.bpsPerPeriod) > 0)) {
    add('DesignUnlockedLiquidity', 'creatorLiquidityVestingInfo', 'Vesting liquidity needs at least one period and a step above zero.');
  }
  return issues;
}

/** `batch::MIN_WINDOW_SECS..=MAX_WINDOW_SECS` and the timestamp start at least `windowSecs` after `now`. */
export function checkBatchStart(input: { now: bigint; windowSecs: number; activationPoint: bigint | null }): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const { now, windowSecs, activationPoint } = input;
  if (!Number.isInteger(windowSecs) || windowSecs < MIN_BATCH_WINDOW_SECS || windowSecs > MAX_BATCH_WINDOW_SECS) {
    issues.push({ code: 'BatchWindow', field: 'batch.windowSecs', message: `A batch window is between ${MIN_BATCH_WINDOW_SECS} seconds and 7 days.` });
  }
  if (activationPoint === null) issues.push({ code: 'BatchActivation', field: 'batch.activationPoint', message: 'A batch-opened market needs a start time (Unix seconds).' });
  else if (activationPoint < now + BigInt(Number.isFinite(windowSecs) ? windowSecs : 0)) {
    issues.push({ code: 'BatchActivation', field: 'batch.activationPoint', message: `The start must be at least the window (${windowSecs} s) after the moment the transaction lands; the earliest start now is ${now + BigInt(windowSecs)}. Allow time to sign and send.` });
  }
  return issues;
}

export type BatchedPoolFee = { feeBps: number; endingFeeBps: number; periods: number; periodSecs: number };

/**
 * `batch::check_batched_pool` on the fee side: the fee must start above where it ends and step down on a timer, and the 27 bytes that DAMM v2 reads must
 * describe a decaying time scheduler (a non-zero cliff fee, period count, frequency and reduction). Compounding is forced by the builder.
 */
export function checkBatchedPoolFee(f: BatchedPoolFee): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const bad = (field: string, message: string) => issues.push({ code: 'BatchFeeNotDecaying', field, message });
  if (!Number.isInteger(f.periods) || f.periods < 1 || f.periods > 0xffff) bad('batch.periods', 'The fee steps down over 1 to 65,535 periods.');
  if (!Number.isInteger(f.periodSecs) || f.periodSecs < 1) bad('batch.periodSecs', 'Each fee period lasts at least one second.');
  if (!Number.isInteger(f.feeBps) || !Number.isInteger(f.endingFeeBps) || f.feeBps <= f.endingFeeBps) bad('feeBps', `A batch-opened pool opens with a fee above the one it settles at: feeBps (${f.feeBps}) must exceed batch.endingFeeBps (${f.endingFeeBps}).`);
  if (issues.length > 0) return issues;
  try {
    const p = getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: f.feeBps, endingFeeBps: f.endingFeeBps, numberOfPeriod: f.periods, totalDuration: f.periods * f.periodSecs } });
    const d = Buffer.from(p.data as number[]);
    const cliff = d.readBigUInt64LE(0);
    const periods = d.readUInt16LE(8);
    const frequency = d.readBigUInt64LE(10);
    const reduction = d.readBigUInt64LE(18);
    if (!(cliff > 0n && periods > 0 && frequency > 0n && reduction > 0n)) bad('feeBps', 'The fee schedule does not decay: the step between the opening and the ending fee rounds to zero.');
  } catch (e) {
    bad('feeBps', (e as Error).message);
  }
  return issues;
}
