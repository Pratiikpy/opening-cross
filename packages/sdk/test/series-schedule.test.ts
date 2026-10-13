// The series schedule and the lockup arithmetic, case by case against programs/cross_core/src/series.rs (`next_close`, the top of `spawn_next`) and lock.rs.
import { describe, expect, it } from 'vitest';
import { type Address } from '@solana/kit';
import { CrossState, type Series } from '@opening-cross/cross-core-client';
import { SPAWN_LEAD_SECS, lockupReleasable, nextSeriesClose, spawnReadiness } from '../src/index.js';

const PREV = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as Address;
const series = (over: { next?: bigint; active?: boolean; max?: bigint; interval?: bigint; start?: bigint; call?: bigint; lastClose?: bigint; last?: Address | null } = {}) =>
  ({
    active: over.active ?? true,
    nextIndex: over.next ?? 0n,
    lastCloseTs: over.lastClose ?? 0n,
    lastCross: over.last ? { __option: 'Some', value: over.last } : { __option: 'None' },
    config: { maxCrosses: over.max ?? 0n, intervalSecs: over.interval ?? 3_600n, startTs: over.start ?? 10_000n, callSecs: over.call ?? 600n },
  }) as unknown as Series;

describe('nextSeriesClose (series.rs next_close)', () => {
  const cfg = { intervalSecs: 100n, startTs: 1_000n };
  it('is the scheduled slot while it is ahead', () => {
    expect(nextSeriesClose(cfg, 0n, 0n, 500n, null)).toBe(1_000n);
    expect(nextSeriesClose(cfg, 3n, 0n, 500n, null)).toBe(1_300n);
  });
  it('skips missed slots: the first slot strictly after the later of now and the last close', () => {
    expect(nextSeriesClose(cfg, 0n, 0n, 1_000n, null)).toBe(1_100n);
    expect(nextSeriesClose(cfg, 0n, 0n, 1_050n, null)).toBe(1_100n);
    expect(nextSeriesClose(cfg, 0n, 0n, 1_099n, null)).toBe(1_100n);
    expect(nextSeriesClose(cfg, 1n, 0n, 1_100n, null)).toBe(1_200n);
    expect(nextSeriesClose(cfg, 0n, 5_000n, 1_100n, null)).toBe(5_100n); // the last close is the floor
  });
  it('on a calendar is the earliest session start after the floor, and null with none ahead', () => {
    const cal = { intervalSecs: 0n, startTs: 0n };
    expect(nextSeriesClose(cal, 0n, 0n, 100n, [500n, 300n, 900n])).toBe(300n);
    expect(nextSeriesClose(cal, 0n, 300n, 100n, [500n, 300n, 900n])).toBe(500n); // strictly after
    expect(nextSeriesClose(cal, 0n, 0n, 1_000n, [500n, 300n, 900n])).toBeNull();
    expect(nextSeriesClose(cal, 0n, 0n, 100n, null)).toBeNull();
  });
});

describe('spawnReadiness (the top of spawn_next)', () => {
  it('refuses a paused series and one that ran its last cross', () => {
    expect(spawnReadiness(series({ active: false }), null, 0n, null)).toMatchObject({ ready: false, reason: 'INACTIVE' });
    expect(spawnReadiness(series({ max: 3n, next: 3n, last: PREV }), { address: PREV, state: CrossState.Finalized }, 0n, null)).toMatchObject({ ready: false, reason: 'DONE' });
    expect(spawnReadiness(series({ max: 3n, next: 2n, last: PREV }), { address: PREV, state: CrossState.Finalized }, 20_000n, null).ready).toBe(true);
  });
  it('needs the previous cross from the second on, and not while it is live', () => {
    expect(spawnReadiness(series({ next: 1n, last: PREV }), null, 20_000n, null)).toMatchObject({ reason: 'PREVIOUS_MISSING' });
    expect(spawnReadiness(series({ next: 1n, last: null }), { address: PREV, state: CrossState.Cleared }, 20_000n, null)).toMatchObject({ reason: 'PREVIOUS_MISSING' });
    expect(spawnReadiness(series({ next: 1n, last: PREV }), { address: '11111111111111111111111111111111' as Address, state: CrossState.Cleared }, 20_000n, null)).toMatchObject({ reason: 'PREVIOUS_MISSING' });
    expect(spawnReadiness(series({ next: 1n, last: PREV }), { address: PREV, state: CrossState.Live }, 20_000n, null)).toMatchObject({ reason: 'PREVIOUS_LIVE' });
    for (const state of [CrossState.Cleared, CrossState.NoPrint, CrossState.Finalized]) expect(spawnReadiness(series({ next: 1n, last: PREV }), { address: PREV, state }, 20_000n, null).ready, CrossState[state]).toBe(true);
    // the first cross needs no previous
    expect(spawnReadiness(series({ next: 0n }), null, 9_000n, null).ready).toBe(true);
  });
  it('is accepted from the lead before the call opens, and not a second earlier', () => {
    // first close at 10_000, call window 600 s: the cross opens at 9_400, so it may be spawned from 9_400 - 86_400
    const s = series({ start: 100_000n });
    const open = 100_000n - 600n;
    const from = open - SPAWN_LEAD_SECS;
    const early = spawnReadiness(s, null, from - 1n, null);
    expect(early).toMatchObject({ ready: false, reason: 'TOO_EARLY', closeTs: 100_000n, openTs: open, spawnableAt: from });
    expect(spawnReadiness(s, null, from, null)).toEqual({ ready: true, closeTs: 100_000n, openTs: open });
  });
  it('a calendar series with no session ahead is not ready', () => {
    const s = series({ interval: 0n });
    expect(spawnReadiness(s, null, 100n, [50n])).toMatchObject({ reason: 'NO_SESSION_AHEAD' });
    expect(spawnReadiness(s, null, 100n, [50n, 700n])).toMatchObject({ ready: true, closeTs: 700n });
  });
});

describe('lockupReleasable (lock.rs Lockup::releasable)', () => {
  const l = (over: Partial<{ amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }> = {}) => ({ amount: 1_000n, released: 0n, startTs: 100n, cliffSecs: 50, vestSecs: 200, ...over });
  it('nothing before the cliff, a straight line after it, everything at the end', () => {
    expect(lockupReleasable(l(), 149n)).toBe(0n);
    expect(lockupReleasable(l(), 150n)).toBe(0n);
    expect(lockupReleasable(l(), 250n)).toBe(500n);
    expect(lockupReleasable(l(), 350n)).toBe(1_000n);
    expect(lockupReleasable(l(), 10_000n)).toBe(1_000n);
  });
  it('everything at the cliff when there is no vesting period, and only what is not yet released', () => {
    expect(lockupReleasable(l({ vestSecs: 0 }), 150n)).toBe(1_000n);
    expect(lockupReleasable(l({ vestSecs: 0 }), 149n)).toBe(0n);
    expect(lockupReleasable(l({ released: 400n }), 250n)).toBe(100n);
    expect(lockupReleasable(l({ released: 1_000n }), 10_000n)).toBe(0n);
  });
  it('does not overflow a u64 amount times a long elapsed time', () => {
    const big = 18_446_744_073_709_551_615n;
    expect(lockupReleasable({ amount: big, released: 0n, startTs: 0n, cliffSecs: 0, vestSecs: 4 * 365 * 86_400 }, BigInt(4 * 365 * 86_400 / 2))).toBe(big / 2n);
  });
});
