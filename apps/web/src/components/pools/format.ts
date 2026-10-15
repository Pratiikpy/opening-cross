// How the pool screens write numbers. Amounts arrive from the API as atoms; these functions turn them into what a person reads without losing exactness
// (bigint end to end) and without ever inventing a figure: a value that is not there is "not read", never zero.
import { formatAtoms, shortAddress } from '../../lib/units';
import type { PoolKind, PoolStatus } from './types';

export const KIND_LABEL: Record<PoolKind, string> = { 'damm-v2': 'DAMM v2 pool', dlmm: 'DLMM pair' };

/** `10` basis points as `0.10%`; whole percents lose the fraction (`300` as `3%`). */
export function bpsText(bps: string | number | bigint | null | undefined): string {
  if (bps === null || bps === undefined) return 'not read';
  const n = BigInt(bps);
  const whole = n / 100n;
  const frac = (n % 100n).toString().padStart(2, '0');
  return frac === '00' ? `${whole}%` : `${whole}.${frac}%`;
}

/** A fee given in (possibly fractional) basis points as a percent: `10` as `0.1%`, `0.5` as `0.005%`. */
export function feePercent(bps: number): string {
  return `${Number((bps / 100).toFixed(4))}%`;
}

/** A signed move in basis points, as the sentence a person wants: `+0.70%`, `-0.05%`, `unchanged`. */
export function movedText(bps: string | null | undefined): string {
  if (bps === null || bps === undefined) return 'not read';
  const n = BigInt(bps);
  if (n === 0n) return 'unchanged';
  const a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : '+'}${bpsText(a)}`;
}

/** Atoms with their token decimals; `maxFraction` caps the digits shown. */
export function amount(atoms: string | bigint | null | undefined, decimals: number, maxFraction = Math.min(decimals, 6)): string {
  if (atoms === null || atoms === undefined) return 'not read';
  return formatAtoms(BigInt(atoms), decimals, maxFraction);
}

/** The price the API sends as a decimal string, trimmed to the digits worth reading. */
export function priceText(decimal: string, places = 6): string {
  const [w, f = ''] = decimal.split('.');
  const frac = f.slice(0, places).replace(/0+$/, '');
  return frac ? `${w}.${frac}` : (w ?? decimal);
}

/** A share of 0 to 1 as a percent with one decimal. */
export function shareText(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** Where a pool stands in words: open, or when and why not. */
export function statusText(s: PoolStatus): string {
  if (s.open) return 'Open for swaps';
  if (s.opensAtPoint !== null && s.pointUnit === 'timestamp') {
    const t = Number(s.opensAtPoint);
    if (Number.isFinite(t)) return `Opens ${new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
  return s.reason ? `Closed: ${s.reason}` : 'Closed';
}

export const explorerAddress = (address: string, network: string): string => `https://explorer.solana.com/address/${address}${network === 'mainnet-beta' ? '' : `?cluster=${network === 'localnet' ? 'custom' : network}`}`;

/** A token as a label: its symbol when the chain gave one, else the short address. */
export const tokenLabel = (mint: string, symbol: string | null | undefined): string => symbol ?? shortAddress(mint);

/** The least a trader accepts: the quoted output less the tolerance, rounded up (the same rule as `minimumOut` in the API, so what the page shows is what is sent). */
export function minimumOutOf(expectedOut: bigint, toleranceBps: number): bigint {
  const num = expectedOut * BigInt(10_000 - toleranceBps);
  return num % 10_000n === 0n ? num / 10_000n : num / 10_000n + 1n;
}

/** The slippage tolerance choices of the trade panel, in basis points. */
export const TOLERANCES = [10, 50, 100, 300] as const;

/**
 * The bin ladder of a DLMM pair as bars valued in quote atoms: an ask bin holds base (token X) worth `amountX * price`, a bid bin holds quote (token Y).
 * Bars are scaled to the tallest, so the chart shows the shape of the liquidity; the table under it has the amounts.
 */
export function ladderBars(
  bins: { binId: number; role: 'active' | 'ask' | 'bid'; priceQ64: bigint; amountX: bigint; amountY: bigint }[],
): { binId: number; role: 'active' | 'ask' | 'bid'; value: bigint; share: number }[] {
  const Q64 = 1n << 64n;
  const values = bins.map((b) => ({ binId: b.binId, role: b.role, value: b.amountY + (b.amountX * b.priceQ64) / Q64 }));
  let max = 0n;
  for (const v of values) if (v.value > max) max = v.value;
  return values.map((v) => ({ ...v, share: max === 0n ? 0 : Number((v.value * 10_000n) / max) / 10_000 }));
}

/**
 * Cumulative depth steps for the cross chart: one point per resting price, bids accumulating from the highest price down and offers from the lowest up.
 * Returns the x position (0 to 1 across the price range of the levels) and the cumulative quantity as a share of the larger side.
 */
export function depthSteps(
  levels: { price: bigint; cumulativeBuy: bigint; cumulativeSell: bigint }[],
): { x: number; buy: number; sell: number; price: bigint }[] {
  if (levels.length === 0) return [];
  const lo = levels[0]!.price;
  const hi = levels.at(-1)!.price;
  let max = 0n;
  for (const l of levels) {
    if (l.cumulativeBuy > max) max = l.cumulativeBuy;
    if (l.cumulativeSell > max) max = l.cumulativeSell;
  }
  const span = hi - lo;
  return levels.map((l) => ({
    price: l.price,
    x: span === 0n ? 0.5 : Number(((l.price - lo) * 10_000n) / span) / 10_000,
    buy: max === 0n ? 0 : Number((l.cumulativeBuy * 10_000n) / max) / 10_000,
    sell: max === 0n ? 0 : Number((l.cumulativeSell * 10_000n) / max) / 10_000,
  }));
}
