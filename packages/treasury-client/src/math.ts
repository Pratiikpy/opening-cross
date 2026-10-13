// Arithmetic of the treasury extension, mirrored from programs/treasury/src/math.rs so a client can show exactly what the program will pay.
// Everything is integer and rounds the way the program does; a figure computed here equals the one the instruction computes at the same instant.
import type { TreasuryExt } from './ext.js';

/** Fixed-point precision of the distribution accumulator. */
export const PREC = 1_000_000_000n;
export const BPS = 10_000n;

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint | null => (d === 0n ? null : (a * b) / d);

/** What the program pays for `amount` coins at NAV: `floor(vault * amount / supply)`. Null when `supply` is zero or `amount` exceeds it. */
export function navPayout(vault: bigint, amount: bigint, supply: bigint): bigint | null {
  if (supply === 0n || amount > supply) return null;
  return mulDiv(vault, amount, supply);
}

/** How much of a stream of `amount` quote atoms that last advanced at `last` and ends at `end` is released by `now`. */
export function streamRelease(amount: bigint, last: bigint, end: bigint, now: bigint): bigint {
  if (now >= end) return amount;
  const elapsed = now - last;
  if (elapsed <= 0n) return 0n;
  return (amount * elapsed) / (end - last);
}

/** The accumulator after the stream has advanced to `now` (`update_stream`): nothing is released while nobody is staked. */
export function accumulatorAt(e: Pick<TreasuryExt, 'accPerStake' | 'totalStaked' | 'streamAmount' | 'streamLast' | 'streamEnd'>, now: bigint): bigint {
  if (e.totalStaked === 0n) return e.accPerStake;
  const released = streamRelease(e.streamAmount, e.streamLast, e.streamEnd, now);
  return released > 0n ? e.accPerStake + (released * PREC) / e.totalStaked : e.accPerStake;
}

/** What a staker can claim at `now`: what the program settled into `pending`, plus what the accumulator has earned since. */
export function claimableOf(position: { amount: bigint; debt: bigint; pending: bigint }, e: Pick<TreasuryExt, 'accPerStake' | 'totalStaked' | 'streamAmount' | 'streamLast' | 'streamEnd'>, now: bigint): bigint {
  const earned = (position.amount * accumulatorAt(e, now)) / PREC;
  return position.pending + (earned > position.debt ? earned - position.debt : 0n);
}

/** Whether a tally passes: a quorum of the circulating supply took part and yes strictly exceeds the threshold of the votes cast. */
export function proposalPasses(yes: bigint, no: bigint, supply: bigint, quorumBps: number, thresholdBps: number): boolean {
  const total = yes + no;
  if (total === 0n || supply === 0n) return false;
  return total * BPS >= BigInt(quorumBps) * supply && yes * BPS > BigInt(thresholdBps) * total;
}

/** The largest single spend a proposal may authorise: `floor(vault * maxBps / 10000)`. */
export const proposalCap = (vault: bigint, maxBps: number): bigint => (vault * BigInt(maxBps)) / BPS;
