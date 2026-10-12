// Band-tied liquidation. The collateral's price is a band, not a number, and the two edges answer two different questions:
//
//   * Lending (opening or increasing debt) is judged at the LOWER edge: borrow only what survives the pessimistic price.
//   * Liquidating is judged at the UPPER edge: a borrower is liquidated only if the position breaches the threshold even at the most
//     favourable price inside the band. A band that merely brushes the threshold on its low side is an `atRisk` warning, not a seizure.
//
// And only against a guarded price, with a usable valuation of acceptable width: a spot tick, a wick or a disagreeing source can
// never liquidate anyone. When the price is too uncertain to act on, the answer is `wait`, which costs a delay, never a user's collateral.
import type { Valuation } from './fair-value.js';

export type Position = {
  /** Collateral in token atoms and its decimals. */
  collateral: bigint;
  collateralDecimals: number;
  /** Debt in quote atoms with 6 decimals (the price is micro-USD per whole token, so values and debt are in the same unit). */
  debt: bigint;
};

export type LiquidationPolicy = {
  /** Liquidate when debt / collateral value at the lower band reaches this, in bps. */
  liquidationLtvBps: number;
  /** Liquidator's discount, in bps. */
  bonusBps: number;
  /** Refuse to act on a band wider than this (full width, bps). */
  maxBandWidthBps: number;
};

export type Decision =
  | { action: 'hold'; ltvLoBps: number; ltvMidBps: number; ltvHiBps: number; atRisk: boolean; reasons: string[] }
  | { action: 'liquidate'; ltvLoBps: number; ltvMidBps: number; ltvHiBps: number; reasons: string[] }
  /** Cannot act now: stale, disagreeing, too wide or unguarded. Nobody is liquidated. */
  | { action: 'wait'; ltvLoBps: number | null; ltvMidBps: number | null; ltvHiBps: number | null; reasons: string[] }
  /** Even at the upper band the liquidation discount cannot cover the debt: bad debt has arrived; governance's problem, not a liquidation's. */
  | { action: 'insolvent'; ltvLoBps: number; ltvMidBps: number; ltvHiBps: number; reasons: string[] };

const pow10 = (n: number) => 10n ** BigInt(n);
const value = (collateral: bigint, decimals: number, price: bigint) => (collateral * price) / pow10(decimals);

export function decide(pos: Position, v: Valuation, policy: LiquidationPolicy): Decision {
  if (pos.debt === 0n) return { action: 'hold', ltvLoBps: 0, ltvMidBps: 0, ltvHiBps: 0, atRisk: false, reasons: ['no debt'] };
  const valueMid = value(pos.collateral, pos.collateralDecimals, v.mid);
  const valueLo = value(pos.collateral, pos.collateralDecimals, v.lo);
  const valueHi = value(pos.collateral, pos.collateralDecimals, v.hi);
  const ratio = (val: bigint) => (val === 0n ? null : Number((pos.debt * 10_000n) / val));
  const ltvMid = ratio(valueMid);
  const ltvLo = ratio(valueLo);
  const ltvHi = ratio(valueHi);
  const reasons = [...v.reasons];
  const wait = (why: string): Decision => ({ action: 'wait', ltvLoBps: ltvLo, ltvMidBps: ltvMid, ltvHiBps: ltvHi, reasons: [...reasons, why] });
  if (!v.usable) return wait('valuation not usable');
  if (v.widthBps > policy.maxBandWidthBps) return wait(`band ${v.widthBps} bps wider than the ${policy.maxBandWidthBps} bps limit`);
  if (!v.guarded) return wait('a liquidation needs a guarded price');
  if (ltvLo === null || ltvMid === null || ltvHi === null) return wait('collateral value rounds to zero');
  // Bad debt: even the most favourable price, sold at the liquidation discount, does not cover the debt.
  if (pos.debt * 10_000n > valueHi * BigInt(10_000 - policy.bonusBps)) return { action: 'insolvent', ltvLoBps: ltvLo, ltvMidBps: ltvMid, ltvHiBps: ltvHi, reasons: [...reasons, 'collateral at the upper band, after the liquidation discount, does not cover the debt'] };
  if (ltvHi >= policy.liquidationLtvBps) return { action: 'liquidate', ltvLoBps: ltvLo, ltvMidBps: ltvMid, ltvHiBps: ltvHi, reasons: [...reasons, `LTV ${ltvHi} bps >= ${policy.liquidationLtvBps} bps even at the upper band`] };
  const atRisk = ltvLo >= policy.liquidationLtvBps;
  return { action: 'hold', ltvLoBps: ltvLo, ltvMidBps: ltvMid, ltvHiBps: ltvHi, atRisk, reasons: atRisk ? [...reasons, `at risk: the lower band (${ltvLo} bps) breaches ${policy.liquidationLtvBps} bps but the upper band (${ltvHi} bps) does not; no liquidation on an uncertain price`] : reasons };
}
