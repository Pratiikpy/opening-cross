// The keeper's duties beyond one cross's lifecycle: each is a pure planner over account data the keeper has just read, so that any number of keepers can run it
// and the program's own checks make every duplicate a harmless failure (ADR-0703).
//
//   challenges  an insider challenge the arbiter left unanswered for 14 days is closed by anyone (the deposit goes back to the challenger, the bond is untouched)
//   locks       the vested part of a locked fill is paid to its owner
//   series      the next cross of a recurring series is spawned when the program would accept it, then its missing shards are created
//   halts       the mint's pause is copied into its halt state, and a verified oracle update is fed to the circuit breaker
import type { Address } from '@solana/kit';
import { CrossState, type HaltState, HaltReason, type Series } from '@opening-cross/cross-core-client';
import { FLAG_FEEDS_LENDERS, lockupReleasable, spawnReadiness } from '@opening-cross/sdk';
import type { Action, Skip } from './plan.js';

export type Planned = { actions: Action[]; skipped: Skip[] };

/** An open challenge may be closed by anyone this long after it was filed (`ARBITER_DEADLINE_SECS`, programs/cross_core/src/neutral.rs). */
export const ARBITER_DEADLINE_SECS = 14n * 24n * 3600n;
/** The oldest an oracle update may be when fed to the breaker is 120 s (`MAX_UPDATE_AGE_SECS`); the keeper sends only one at most this old, to leave room for the landing. */
export const OBSERVE_MAX_AGE_SECS = 90n;

// ------------------------------------------------------------------ challenges

export type ChallengeFacts = { id: number; address: Address; challenger: Address; filedTs: bigint; open: boolean };

export function planExpiries(cross: Address, found: readonly ChallengeFacts[], now: bigint): Planned {
  const actions: Action[] = [];
  const skipped: Skip[] = [];
  let earliest: bigint | null = null;
  for (const c of found) {
    if (!c.open) continue;
    const at = c.filedTs + ARBITER_DEADLINE_SECS;
    if (now >= at) actions.push({ kind: 'expire-challenge', cross, id: c.id, challenge: c.address, challenger: c.challenger });
    else if (earliest === null || at < earliest) earliest = at;
  }
  if (earliest !== null) skipped.push({ cross, code: 'CHALLENGE_WAITING', reason: `an open challenge can be closed by anyone from ${earliest} if the arbiter has not ruled` });
  return { actions, skipped };
}

// ------------------------------------------------------------------ locked fills

export type LockFacts = { address: Address; cross: Address; owner: Address; nonce: bigint; amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number };

/**
 * Releases a lockup when at least `minRelease` atoms have vested unreleased, or when what is left is all that remains (the last release is always worth sending).
 * The first release also creates the owner's token account, which the keeper pays for: that is why locks are an opt-in duty.
 */
export function planRelease(l: LockFacts, now: bigint, minRelease = 1n): Action | null {
  const releasable = lockupReleasable(l, now);
  if (releasable === 0n) return null;
  const last = l.released + releasable === l.amount;
  if (releasable < minRelease && !last) return null;
  return { kind: 'release-locked', cross: l.cross, lockup: l.address, owner: l.owner, nonce: l.nonce, releasable };
}

// ------------------------------------------------------------------ recurring series

export type SeriesFacts = { address: Address; series: Series; previous: { address: Address; state: CrossState } | null; sessionStarts: bigint[] | null };

const WAITING: Record<string, string> = {
  PREVIOUS_LIVE: 'the previous cross of the series is still live: crosses of a series run one at a time',
  PREVIOUS_MISSING: 'the previous cross of the series cannot be read, so the next cannot be spawned',
  NO_SESSION_AHEAD: 'the series calendar has no session ahead',
};

export function planSpawn(f: SeriesFacts, now: bigint): Planned {
  const r = spawnReadiness(f.series, f.previous, now, f.sessionStarts);
  const here = f.address;
  if (r.ready) return { actions: [{ kind: 'spawn-next', series: here, feed: (f.series.config.rules.flags & FLAG_FEEDS_LENDERS) !== 0 }], skipped: [] };
  const skip = (code: string, reason: string): Planned => ({ actions: [], skipped: [{ cross: here, code, reason }] });
  switch (r.reason) {
    case 'INACTIVE':
      return skip('SERIES_PAUSED', 'the series is paused by its authority');
    case 'DONE':
      return skip('SERIES_DONE', 'the series has run its last cross');
    case 'TOO_EARLY':
      return skip('SERIES_WAITING', `the next cross opens at ${r.openTs}; the program accepts it from ${r.spawnableAt}`);
    default:
      return skip('SERIES_WAITING', WAITING[r.reason]!);
  }
}

// ------------------------------------------------------------------ halt states

export type HaltFacts = {
  address: Address;
  halt: HaltState;
  /** Whether the base mint's pausable extension is paused now; null when it could not be read. */
  mintPaused: boolean | null;
  /** A recent verified Pyth update for the breaker's feed, when the keeper has one. */
  update: { account: Address; publishTime: bigint } | null;
};

const REASON = ['none', 'issuer pause', 'venue halt', 'circuit breaker', 'corporate action'];

export function planHalt(f: HaltFacts, now: bigint): Planned {
  const h = f.halt;
  const actions: Action[] = [];
  const skipped: Skip[] = [];
  const here = f.address;
  // The issuer's pause: copied into the halt state by anyone. A paused mint halts the asset; an unpaused one marks `issuer_unpaused`, which tells the authority a resume cross is due.
  if (f.mintPaused === true && !h.halted) actions.push({ kind: 'sync-pause', halt: here, baseMint: h.baseMint, because: 'paused' });
  else if (f.mintPaused === false && h.halted && h.reason === HaltReason.IssuerPause && !h.issuerUnpaused) actions.push({ kind: 'sync-pause', halt: here, baseMint: h.baseMint, because: 'unpaused' });
  // The circuit breaker: only an update newer than the last one observed and young enough is accepted, and a breaker that has halted the asset needs no more.
  const b = h.breaker.__option === 'Some' ? h.breaker.value : null;
  if (b && !h.halted && f.update && f.update.publishTime > b.lastPublishTs && now - f.update.publishTime <= OBSERVE_MAX_AGE_SECS && f.update.publishTime <= now + 5n) {
    actions.push({ kind: 'observe-price', halt: here, baseMint: h.baseMint, priceUpdate: f.update.account });
  }
  if (h.halted) {
    const lifted = h.issuerUnpaused ? ' The issuer has lifted its pause.' : '';
    skipped.push({ cross: here, code: 'HALTED', reason: `${h.baseMint} is halted (${REASON[h.reason] ?? h.reason}) since ${h.sinceTs}.${lifted} Only a printing resume cross created by ${h.authority}${h.venueSigner.__option === 'Some' ? ` or ${h.venueSigner.value}` : ''} lifts the halt.` });
  }
  if (h.corporateAction) {
    skipped.push({ cross: here, code: 'CORPORATE_ACTION', reason: `a corporate action is flagged on ${h.baseMint}: crosses that name this halt state print no price (the clear records the reason) until a resume cross prints` });
  }
  return { actions, skipped };
}
