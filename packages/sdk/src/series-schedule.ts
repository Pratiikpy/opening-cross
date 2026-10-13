// When a recurring series may spawn its next cross, and what the lockup of a locked fill has released: the program's own arithmetic, so that a caller
// (the API before it hands out a transaction, the keeper before it sends one) knows the answer the program will give.
//
// `nextSeriesClose` is `next_close` of programs/cross_core/src/series.rs and `spawnReadiness` is the conditions at the top of `spawn_next`; `lockupReleasable` is
// `Lockup::releasable` of lock.rs. Tests pin each case of those functions (test/series-schedule.test.ts).
import type { Address } from '@solana/kit';
import { CrossState, type Series } from '@opening-cross/cross-core-client';

/** A cross is spawned at most this long before it opens (`SPAWN_LEAD_SECS`). */
export const SPAWN_LEAD_SECS = 24n * 60n * 60n;

/**
 * Close time of the series' next cross. In interval mode the first slot strictly after the later of `now` and the last close (missed slots are skipped);
 * on a calendar the earliest session start after it. Null when the calendar has no session ahead.
 */
export function nextSeriesClose(cfg: { intervalSecs: bigint; startTs: bigint }, index: bigint, lastCloseTs: bigint, now: bigint, sessionStarts: readonly bigint[] | null): bigint | null {
  const floor = now > lastCloseTs ? now : lastCloseTs;
  if (cfg.intervalSecs > 0n) {
    const first = cfg.startTs + index * cfg.intervalSecs;
    if (first > floor) return first;
    const steps = (floor - first) / cfg.intervalSecs + 1n;
    return first + steps * cfg.intervalSecs;
  }
  if (!sessionStarts) return null;
  let best: bigint | null = null;
  for (const t of sessionStarts) if (t > floor && (best === null || t < best)) best = t;
  return best;
}

export type SpawnReadiness =
  | { ready: true; closeTs: bigint; openTs: bigint }
  /** `spawnableAt` is set for TOO_EARLY: the first second `spawn_next` is accepted. */
  | { ready: false; reason: 'INACTIVE' | 'DONE' | 'PREVIOUS_MISSING' | 'PREVIOUS_LIVE' | 'NO_SESSION_AHEAD' | 'TOO_EARLY'; closeTs?: bigint; openTs?: bigint; spawnableAt?: bigint };

/**
 * Whether `spawn_next` would be accepted at `now`. `previous` is the series' last cross as read from chain (null: the account is missing); it is required from the
 * second cross on. `sessionStarts` are the series calendar's session starts (null when the series has none or it could not be read).
 */
export function spawnReadiness(series: Series, previous: { address: Address; state: CrossState } | null, now: bigint, sessionStarts: readonly bigint[] | null): SpawnReadiness {
  const cfg = series.config;
  if (!series.active) return { ready: false, reason: 'INACTIVE' };
  if (cfg.maxCrosses > 0n && series.nextIndex >= cfg.maxCrosses) return { ready: false, reason: 'DONE' };
  if (series.nextIndex > 0n) {
    if (series.lastCross.__option !== 'Some' || !previous || previous.address !== series.lastCross.value) return { ready: false, reason: 'PREVIOUS_MISSING' };
    if (previous.state === CrossState.Live) return { ready: false, reason: 'PREVIOUS_LIVE' };
  }
  const closeTs = nextSeriesClose(cfg, series.nextIndex, series.lastCloseTs, now, sessionStarts);
  if (closeTs === null) return { ready: false, reason: 'NO_SESSION_AHEAD' };
  const openTs = closeTs - cfg.callSecs;
  if (now + SPAWN_LEAD_SECS < openTs) return { ready: false, reason: 'TOO_EARLY', closeTs, openTs, spawnableAt: openTs - SPAWN_LEAD_SECS };
  return { ready: true, closeTs, openTs };
}

/** `Lockup::releasable`: nothing before the cliff, everything at the cliff when there is no vesting period, a straight line over it after. */
export function lockupReleasable(l: { amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }, now: bigint): bigint {
  const unlock = l.startTs + BigInt(l.cliffSecs);
  if (now < unlock) return 0n;
  let vested: bigint;
  if (l.vestSecs === 0) vested = l.amount;
  else {
    vested = (l.amount * (now - unlock)) / BigInt(l.vestSecs);
    if (vested > l.amount) vested = l.amount;
  }
  return vested > l.released ? vested - l.released : 0n;
}
