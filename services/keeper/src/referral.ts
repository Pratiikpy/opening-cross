// The referral a cross pays when it is finalized (ADR-0460), as far as the keeper needs to know it: `finalize` transfers a share of the protocol fee to the
// referrer's quote token account, and refuses (`ReferralAccountMissing`) when that account does not exist. The SDK's `buildFinalizeWithAccounts` opens it first, so a
// referrer who has never held the quote mint cannot leave a cross unfinalized. The arithmetic here mirrors `finalize` in programs/cross_core/src/lib.rs line for line; it
// says what the referrer will be paid.
import { type Cross, type CrossExt, SupplyMode } from '@opening-cross/cross-core-client';

const BPS = 10_000n;

/** `floor(a * b / d)` in 128-bit arithmetic that must fit 64 bits, as the program's `mul_div` (it errors on overflow; so does this). */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  const v = (a * b) / d;
  if (v >= 1n << 64n) throw new RangeError('fee arithmetic overflows u64');
  return v;
}

/** The fees `finalize` splits: in a minting cross the issuer pays on what buyers paid, in an escrow cross the sum of the sellers' claim fees. */
function totalFees(c: Cross): bigint {
  const totalBps = BigInt(Math.min(c.protocolFeeBps + c.integratorFeeBps, 65_535));
  return c.supplyMode === SupplyMode.Escrow ? c.feesAccrued : mulDiv(c.buyerPaid, totalBps, BPS);
}

/** The part of the protocol fee `finalize` would pay the cross's referrer now; 0n when the cross names none or the share rounds to nothing. */
export function referralOwed(c: Cross, ext: CrossExt | null): bigint {
  if (!ext || ext.referral.shareBps === 0) return 0n;
  const totalBps = BigInt(Math.min(c.protocolFeeBps + c.integratorFeeBps, 65_535));
  const protocolFee = totalBps === 0n ? 0n : mulDiv(totalFees(c), BigInt(c.protocolFeeBps), totalBps);
  return protocolFee > 0n ? mulDiv(protocolFee, BigInt(ext.referral.shareBps), BPS) : 0n;
}
