// Exact integer math for the premium. No float touches a price, a ratio or a share count.
//
// A share token reports balances through the mint's Scaled UI Amount multiplier: shares = atoms x multiplier / 10^decimals.
// The multiplier is stored by the token program as an f64, so it is taken once, as its shortest decimal string, and
// carried as an integer scaled by 10^12 from then on.
import type { Leg } from './types.js';

export const MULTIPLIER_SCALE = 10n ** 12n;
const E6 = 10n ** 6n;

export function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const n = a < 0n ? -a : a;
  const d = b < 0n ? -b : b;
  const q = (2n * n + d) / (2n * d);
  return neg ? -q : q;
}

/** A multiplier such as 1.0305 as an integer scaled by 10^12; throws if it would lose digits or is not positive. */
export function multiplierE12(m: number): bigint {
  if (!Number.isFinite(m) || m <= 0) throw new Error(`multiplier ${m} is not a positive number`);
  const text = m.toFixed(12);
  const [whole, frac = ''] = text.split('.');
  const scaled = BigInt(whole as string) * MULTIPLIER_SCALE + BigInt(frac.padEnd(12, '0').slice(0, 12));
  if (scaled === 0n) throw new Error(`multiplier ${m} is below the resolution of 10^-12`);
  return scaled;
}

export const multiplierText = (m: bigint): string => {
  const whole = m / MULTIPLIER_SCALE;
  const frac = (m % MULTIPLIER_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/**
 * Executable price per share, micro-USD, from a quote's two legs.
 *   buy:  quoteAtoms is what was paid (USDC, 6 dp); rounded UP so a payer is never understated.
 *   sell: quoteAtoms is what was received; rounded DOWN so a receiver is never overstated.
 * Returns null when the quote moves no shares.
 */
export function perShareE6(leg: Leg, quoteAtomsMicroUsd: bigint, tokenAtoms: bigint, decimals: number, mult: bigint): bigint | null {
  if (tokenAtoms <= 0n || mult <= 0n) return null;
  const num = quoteAtomsMicroUsd * 10n ** BigInt(decimals) * MULTIPLIER_SCALE;
  const den = tokenAtoms * mult;
  const v = leg === 'buy' ? divCeil(num, den) : num / den;
  return v === 0n ? null : v;
}

/** Token atoms that are worth `sizeUsd` at `referenceE6` per share (floor): the amount to sell for a size-matched sell quote. */
export function atomsForNotional(sizeUsd: number, referenceE6: bigint, decimals: number, mult: bigint): bigint {
  const notionalE6 = BigInt(sizeUsd) * E6;
  return (notionalE6 * 10n ** BigInt(decimals) * MULTIPLIER_SCALE) / (referenceE6 * mult);
}

/** Signed distance of a price from a reference in basis points x100: round((price - ref) x 10^6 / ref). */
export function premiumBpsX100(priceE6: bigint, referenceE6: bigint): bigint {
  return divRound((priceE6 - referenceE6) * E6, referenceE6);
}

/** Basis points x100 as a percent with two decimals: 1234 is 12.34 bps, 0.1234%, shown '0.12%'. */
export function percentText(bpsX100: bigint): string {
  const neg = bpsX100 < 0n;
  const hundredthsOfPercent = divRound(neg ? -bpsX100 : bpsX100, 100n);
  const whole = hundredthsOfPercent / 100n;
  const frac = (hundredthsOfPercent % 100n).toString().padStart(2, '0');
  return `${neg && hundredthsOfPercent !== 0n ? '-' : ''}${whole}.${frac}%`;
}
