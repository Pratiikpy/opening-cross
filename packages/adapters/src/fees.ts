// Volatility-aware trading fees for a DBC continuation.
//
// DBC adds a dynamic fee on top of the base fee mode (ADR-0017). The dynamic fee follows recent price movement
// through an on-chain volatility accumulator and cools down as the pool calms. This file turns a product-level
// design ("the fee may add up to half the base fee once the price has moved 10%") into the raw parameters the
// program takes, with the same arithmetic the program uses, and exposes the fee model so a design can be inspected
// before it is deployed.
//
// What DBC does NOT offer: a fee keyed to the market session of the underlying (pre-market, overnight, weekend).
// Neither the DBC nor the DAMM v2 IDL has such a mode and the docs describe only the base modes (linear and
// exponential scheduler from activation) plus the volatility layer. A design that needs session-aware fees has to
// change the fee from outside the pool, which is not part of this package.
import BN from 'bn.js';
import {
  BIN_STEP_BPS_DEFAULT,
  BIN_STEP_BPS_U128_DEFAULT,
  DYNAMIC_FEE_DECAY_PERIOD_DEFAULT,
  DYNAMIC_FEE_FILTER_PERIOD_DEFAULT,
  DYNAMIC_FEE_REDUCTION_FACTOR_DEFAULT,
  DYNAMIC_FEE_ROUNDING_OFFSET,
  DYNAMIC_FEE_SCALING_FACTOR,
  FEE_DENOMINATOR,
  MAX_BASIS_POINT,
  MAX_FEE_NUMERATOR,
  MAX_PRICE_CHANGE_BPS_DEFAULT,
  U24_MAX,
  bpsToFeeNumerator,
  getDynamicFeeParams,
  validateDynamicFee,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { DynamicFeeParameters } from '@meteora-ag/dynamic-bonding-curve-sdk';

export interface VolatilityFeeDesign {
  /** The base fee the dynamic layer sits on, in basis points (the scheduler's ending fee for a settled pool). */
  readonly baseFeeBps: number;
  /**
   * The most the dynamic fee may add, as a share of the base fee: 0.5 means a base of 1.00% can rise to 1.50%.
   * The SDK's own helper fixes this at 0.2.
   */
  readonly extraFeeShareOfBase: number;
  /** The price move, in basis points, at which the dynamic fee reaches that cap. At most 1500. */
  readonly maxPriceChangeBps: number;
  /** Seconds in which swaps are treated as one burst. Default 10. */
  readonly filterPeriodSeconds?: number;
  /** Seconds after which volatility starts to decay. Must exceed the filter period. Default 120. */
  readonly decayPeriodSeconds?: number;
  /** How much of the volatility reference survives each decay, in basis points of 10 000. Default 5000. */
  readonly reductionFactorBps?: number;
}

const toNumber = (b: BN): number => b.toNumber();

/** Raw DBC dynamic-fee parameters for a design. Throws when the design cannot be expressed on chain. */
export function volatilityFeeParams(d: VolatilityFeeDesign): DynamicFeeParameters {
  if (!(d.baseFeeBps > 0)) throw new Error('baseFeeBps must be positive');
  if (!(d.extraFeeShareOfBase > 0)) throw new Error('extraFeeShareOfBase must be positive');
  if (!(d.maxPriceChangeBps > 0) || d.maxPriceChangeBps > MAX_PRICE_CHANGE_BPS_DEFAULT) {
    throw new Error(`maxPriceChangeBps must be in (0, ${MAX_PRICE_CHANGE_BPS_DEFAULT}]`);
  }
  const filter = d.filterPeriodSeconds ?? DYNAMIC_FEE_FILTER_PERIOD_DEFAULT;
  const decay = d.decayPeriodSeconds ?? DYNAMIC_FEE_DECAY_PERIOD_DEFAULT;
  const reduction = d.reductionFactorBps ?? DYNAMIC_FEE_REDUCTION_FACTOR_DEFAULT;
  if (!Number.isInteger(filter) || !Number.isInteger(decay) || filter < 0 || filter >= decay) throw new Error('filterPeriodSeconds must be a whole number below decayPeriodSeconds');
  if (!Number.isInteger(reduction) || reduction < 0 || reduction > MAX_BASIS_POINT) throw new Error(`reductionFactorBps must be in [0, ${MAX_BASIS_POINT}]`);

  // The cap on the accumulator depends only on the price move, so it comes from the SDK's own derivation.
  const reference = getDynamicFeeParams(d.baseFeeBps, d.maxPriceChangeBps);
  const baseNumerator = new BN(bpsToFeeNumerator(d.baseFeeBps));
  // Integer share in millionths so no float reaches the on-chain number.
  const shareMillionths = Math.round(d.extraFeeShareOfBase * 1_000_000);
  const maxDynamicNumerator = baseNumerator.mul(new BN(shareMillionths)).div(new BN(1_000_000));
  if (baseNumerator.add(maxDynamicNumerator).gt(new BN(MAX_FEE_NUMERATOR))) throw new Error('base fee plus the largest dynamic fee would exceed the 99% cap');
  const squared = new BN(reference.maxVolatilityAccumulator).mul(new BN(BIN_STEP_BPS_DEFAULT)).pow(new BN(2));
  const control = maxDynamicNumerator.mul(DYNAMIC_FEE_SCALING_FACTOR).sub(DYNAMIC_FEE_ROUNDING_OFFSET).div(squared);
  if (control.lten(0)) throw new Error('the design adds less than one unit of fee; raise extraFeeShareOfBase or baseFeeBps');
  if (control.gt(new BN(U24_MAX))) {
    const fits = new BN(U24_MAX).mul(squared).add(DYNAMIC_FEE_ROUNDING_OFFSET).div(DYNAMIC_FEE_SCALING_FACTOR);
    throw new Error(`variable fee control ${control.toString()} exceeds the on-chain limit; the largest extra fee for this price move is ${(Number(fits.mul(new BN(10_000)).div(baseNumerator).toString()) / 10_000).toFixed(4)} of the base fee`);
  }
  const params: DynamicFeeParameters = {
    binStep: BIN_STEP_BPS_DEFAULT,
    binStepU128: BIN_STEP_BPS_U128_DEFAULT,
    filterPeriod: filter,
    decayPeriod: decay,
    reductionFactor: reduction,
    maxVolatilityAccumulator: reference.maxVolatilityAccumulator,
    variableFeeControl: toNumber(control),
  };
  if (!validateDynamicFee(params)) throw new Error('the SDK rejects these dynamic fee parameters');
  return params;
}

/**
 * The dynamic fee, as a numerator over FEE_DENOMINATOR (1e9), for a volatility accumulator reading.
 * This is the program's formula: ceil((accumulator x binStep)^2 x variableFeeControl / 1e11).
 */
export function dynamicFeeNumerator(p: DynamicFeeParameters, volatilityAccumulator: number | bigint): bigint {
  const va = BigInt(volatilityAccumulator);
  const capped = va > BigInt(p.maxVolatilityAccumulator) ? BigInt(p.maxVolatilityAccumulator) : va;
  const squared = (capped * BigInt(p.binStep)) ** 2n;
  const scaling = BigInt(DYNAMIC_FEE_SCALING_FACTOR.toString());
  return (squared * BigInt(p.variableFeeControl) + scaling - 1n) / scaling;
}

/** The same fee in basis points as a decimal. */
export const dynamicFeeBps = (p: DynamicFeeParameters, volatilityAccumulator: number | bigint): number =>
  (Number(dynamicFeeNumerator(p, volatilityAccumulator)) * 10_000) / Number(FEE_DENOMINATOR);

/** The largest dynamic fee this design can ever charge, in basis points. */
export const maxDynamicFeeBps = (p: DynamicFeeParameters): number => dynamicFeeBps(p, p.maxVolatilityAccumulator);
