// Liquidity health of a full-range constant-product pool (ADR-0486, row D9): depth, slippage at set sizes and persistence.
//
// A DAMM v2 pool opened by the adapter is full range, so its two vaults satisfy x * y = k and every figure here is exact integer
// arithmetic on the vault balances; nothing is sampled or estimated. Pools with concentrated liquidity (DLMM) are not covered:
// their depth depends on the bins and is read from the bin arrays, which this module does not do.

const BPS = 10_000n;

export type Reserves = { reserveIn: bigint; reserveOut: bigint };

function check(r: Reserves) {
  if (r.reserveIn <= 0n || r.reserveOut <= 0n) throw new Error('both reserves must be positive');
}

/** Output of a constant-product swap of `amountIn` with the fee taken from the input (rounded down, as a pool rounds in its own favour). */
export function quoteOut(r: Reserves, amountIn: bigint, feeBps: number): bigint {
  check(r);
  if (amountIn < 0n) throw new Error('amountIn must not be negative');
  if (feeBps < 0 || feeBps >= 10_000) throw new Error('feeBps must be within [0, 10,000)');
  const net = (amountIn * (BPS - BigInt(feeBps))) / BPS;
  return (net * r.reserveOut) / (r.reserveIn + net);
}

/**
 * Slippage of a swap against the pool's mid price, in basis points, rounded up: how much worse than the mid price the
 * trader's average price is, fee included. Zero for a zero-size trade.
 */
export function slippageBps(r: Reserves, amountIn: bigint, feeBps: number): bigint {
  if (amountIn === 0n) return 0n;
  const out = quoteOut(r, amountIn, feeBps);
  // mid price gives amountIn * reserveOut / reserveIn; slippage = 1 - out / ideal.
  const ideal = (amountIn * r.reserveOut) / r.reserveIn;
  if (ideal === 0n) return BPS;
  if (out >= ideal) return 0n;
  return ((ideal - out) * BPS + ideal - 1n) / ideal;
}

/** The largest input whose slippage stays within `maxSlippageBps`, found by bisection on the monotone slippage curve. */
export function depthAtSlippage(r: Reserves, maxSlippageBps: bigint, feeBps: number): bigint {
  check(r);
  if (maxSlippageBps < 0n || maxSlippageBps >= BPS) throw new Error('maxSlippageBps must be within [0, 10,000)');
  if (slippageBps(r, 1n, feeBps) > maxSlippageBps && r.reserveIn < 1_000_000n) return 0n;
  let lo = 0n;
  let hi = r.reserveIn * 1_000n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (slippageBps(r, mid, feeBps) <= maxSlippageBps) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export type DepthSnapshot = { timestamp: number; reserveA: bigint; reserveB: bigint };

/**
 * Persistence: the share of the observed time, weighted by the gap to the next snapshot, during which the pool could absorb a
 * sell of `sizeIn` token A within `maxSlippageBps`. Snapshots must be in time order; the last one carries no weight.
 */
export function persistence(snapshots: DepthSnapshot[], sizeIn: bigint, maxSlippageBps: bigint, feeBps: number): number {
  let ok = 0;
  let total = 0;
  for (let i = 0; i + 1 < snapshots.length; i++) {
    const s = snapshots[i]!;
    const gap = snapshots[i + 1]!.timestamp - s.timestamp;
    if (gap < 0) throw new Error('snapshots must be in time order');
    total += gap;
    if (s.reserveA > 0n && s.reserveB > 0n && slippageBps({ reserveIn: s.reserveA, reserveOut: s.reserveB }, sizeIn, feeBps) <= maxSlippageBps) ok += gap;
  }
  return total === 0 ? 0 : ok / total;
}
