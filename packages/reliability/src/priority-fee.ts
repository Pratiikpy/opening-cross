// Priority fees: what to pay, and the two compute-budget instructions that pay it. The estimate comes from what the
// cluster charged recently for the accounts the transaction writes to (getRecentPrioritizationFees), taken at a
// percentile, then capped so a congested moment cannot make one transaction cost more than the caller allows.
import { type Address, address } from '@solana/kit';

export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');

export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export interface FeeEstimate {
  /** Micro-lamports per compute unit. */
  microLamports: bigint;
  /** Where the number came from: the cluster's recent fees, or the floor because there was nothing to go on. */
  basis: 'recent-fees' | 'floor' | 'capped';
  /** Recent slots sampled. */
  samples: number;
}

export interface FeeOptions {
  /** Which percentile of recent slot fees to pay. Default 0.75. */
  percentile?: number;
  /** Never pay less than this. Default 0. */
  floor?: bigint;
  /** Never let the whole priority fee for `computeUnits` exceed this many lamports. Default 100,000 (0.0001 SOL). */
  maxTotalLamports?: bigint;
  computeUnits?: number;
}

/** Percentile (0 to 1) of a list, nearest-rank, over BigInts. */
export function percentileOf(values: readonly bigint[], p: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank]!;
}

export async function estimatePriorityFee(rpc: RpcLike, writable: readonly string[], opts: FeeOptions = {}): Promise<FeeEstimate> {
  const floor = opts.floor ?? 0n;
  const units = BigInt(opts.computeUnits ?? 200_000);
  const maxTotal = opts.maxTotalLamports ?? 100_000n;
  let fees: bigint[] = [];
  try {
    const r = await rpc.call<{ slot: number; prioritizationFee: number }[]>('getRecentPrioritizationFees', [writable.slice(0, 128)]);
    fees = r.map((x) => BigInt(x.prioritizationFee));
  } catch {
    // No estimate is better than a failed transaction: fall back to the floor.
  }
  if (fees.length === 0) return { microLamports: floor, basis: 'floor', samples: 0 };
  let price = percentileOf(fees, opts.percentile ?? 0.75);
  if (price < floor) price = floor;
  // total lamports = price (micro-lamports per unit) * units / 1,000,000, rounded up
  const cap = (maxTotal * 1_000_000n) / units;
  if (price > cap) return { microLamports: cap, basis: 'capped', samples: fees.length };
  return { microLamports: price, basis: 'recent-fees', samples: fees.length };
}

export interface Instruction {
  programAddress: Address;
  accounts: [];
  data: Uint8Array;
}

/** SetComputeUnitLimit: the transaction may use at most `units`. */
export function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

/** SetComputeUnitPrice: pay `microLamports` per compute unit. */
export function setComputeUnitPrice(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

/** A unit limit for a transaction whose simulation used `consumed` units: 15% above it, never below 5,000 or above the 1.4M cluster maximum. */
export function unitLimitFor(consumed: number | null, fallback = 200_000): number {
  if (consumed === null) return fallback;
  return Math.min(1_400_000, Math.max(5_000, Math.ceil(consumed * 1.15)));
}

/** The two instructions to put first in a transaction. */
export function computeBudgetInstructions(units: number, microLamports: bigint): Instruction[] {
  return [setComputeUnitLimit(units), setComputeUnitPrice(microLamports)];
}

/** What the priority fee costs in lamports, rounded up. */
export function priorityFeeLamports(units: number, microLamports: bigint): bigint {
  return (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
}
