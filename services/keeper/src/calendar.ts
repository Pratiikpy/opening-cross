// The calendar trigger (ROADMAP C6, ADR-0011).
//
// A cross scheduled on a cross_calendar closes exactly when one of that calendar's sessions starts, so its clearing time
// is published a week ahead and is the moment the market reopens. The keeper's ordinary pass already clears any cross
// whose time has come (plan.ts); what a calendar adds is knowing WHEN, so the keeper sleeps to the session boundary
// instead of discovering the cross up to a full pass late, and says in its log which session boundary a clearing belongs to.
//
// Nothing here decides whether to act. That stays with `plan` and the program's own clock check, from account data read
// in the pass; the calendar account is read only to name the session. Scoping is the keeper's: `crosses` is the same
// discovery the pass uses (already limited to KEEPER_CREATORS) and `accept` is the same filter, so a scoped keeper never
// reads, waits for or clears anyone else's cross.
import type { Address } from '@solana/kit';
import { type Cross, CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';
import { type Session, calendarSessions, sessionStartingAt } from '@opening-cross/indexer';
import type { AccountFetcher, PassResult } from './keeper.js';

export type CalendarWatch = {
  cross: Address;
  calendar: Address;
  /** The moment the cross stops taking orders: the start of the session it is scheduled on. */
  closeTs: bigint;
  /** When it can be cleared (equal to closeTs for an open book, later for a sealed one). */
  revealEndTs: bigint;
  /** Whether the cross was still taking or awaiting its clearing when scanned; only a Live cross is waited for. */
  live: boolean;
  /** The session starting at `closeTs` on the calendar as it reads now; null if the calendar was changed after the cross was made. */
  session: Session | null;
};

export type CalendarTrigger = {
  /** The cross, the calendar session it was cleared for, and the transaction that did it. */
  cross: Address;
  calendar: Address;
  sessionStartTs: bigint | null;
  clearAfterTs: bigint;
  signature: string;
};

export type CalendarTriggerDeps = {
  /** The pass's own candidate discovery. */
  crosses: () => Promise<Address[]>;
  fetch: AccountFetcher;
  /** The pass's own scope filter. */
  accept?: (cross: Cross) => boolean;
};

/** Floor on any sleep, so the wait for the cluster clock to pass a boundary never becomes a hot loop. */
const MIN_WAIT_MS = 1_000;
/** Past the boundary by this much before waking, so the first look already sees a cluster clock at or beyond it. */
const SETTLE_MS = 500;

export function createCalendarTrigger(d: CalendarTriggerDeps) {
  /** Crosses already known to be bound to no calendar (or to belong to someone else): never read again, the binding cannot change. */
  const unbound = new Set<string>();

  async function scan(): Promise<CalendarWatch[]> {
    const watches: CalendarWatch[] = [];
    const calendars = new Map<string, Session[] | null>();
    for (const address of await d.crosses()) {
      if (unbound.has(address)) continue;
      const data = await d.fetch(address);
      if (!data) continue;
      const cross = getCrossDecoder().decode(data);
      if (d.accept && !d.accept(cross)) {
        unbound.add(address);
        continue;
      }
      if (cross.calendar.__option !== 'Some') {
        unbound.add(address);
        continue;
      }
      if (cross.state === CrossState.Finalized) continue;
      const calendar = cross.calendar.value;
      if (!calendars.has(calendar)) {
        const raw = await d.fetch(calendar);
        calendars.set(calendar, raw ? calendarSessions(raw) : null);
      }
      const sessions = calendars.get(calendar) ?? null;
      watches.push({ cross: address, calendar, closeTs: cross.closeTs, revealEndTs: cross.revealEndTs, live: cross.state === CrossState.Live, session: sessions && sessionStartingAt(sessions, cross.closeTs) });
    }
    return watches;
  }

  return { scan };
}

/** The clearings of this pass that belong to a calendar-bound cross, with the session each was waiting for. */
export function calendarTriggers(res: PassResult, watches: readonly CalendarWatch[]): CalendarTrigger[] {
  const byCross = new Map(watches.map((w) => [w.cross as string, w]));
  const out: CalendarTrigger[] = [];
  for (const { action, signature } of res.done) {
    if (action.kind !== 'settle') continue;
    const w = byCross.get(action.cross);
    // One clearing per cross: the pass re-plans after a step, and only the first settle is the boundary's.
    if (w && !out.some((t) => t.cross === w.cross)) out.push({ cross: w.cross, calendar: w.calendar, sessionStartTs: w.session?.startTs ?? null, clearAfterTs: w.revealEndTs, signature });
  }
  return out;
}

/** How long after its time an unsettled calendar cross is retried every second or two, before the ordinary pass interval takes over. */
const GRACE_SECONDS = 30n;

/**
 * How long to sleep: until the next calendar-bound Live cross can be cleared, but never longer than `passMs` (new crosses are
 * found on the next pass) and never shorter than a second. `now` is the cluster clock in unix seconds, read after the pass.
 * A pass that ran into the boundary (the cluster clock passed it while the pass was reading) has not been able to clear the
 * cross yet, so a cross that is due and still unsettled is retried at the floor for `GRACE_SECONDS`; after that it is left to the
 * ordinary pass interval, so a cross that cannot be cleared (a halted mint, say) is not hammered.
 */
export function wakeDelayMs(watches: readonly CalendarWatch[], now: bigint, passMs: number): number {
  let soonest: bigint | null = null;
  for (const w of watches) {
    if (!w.live) continue;
    if (w.revealEndTs > now) {
      if (soonest === null || w.revealEndTs < soonest) soonest = w.revealEndTs;
    } else if (now - w.revealEndTs < GRACE_SECONDS) return MIN_WAIT_MS;
  }
  if (soonest === null) return passMs;
  const ms = Number(soonest - now) * 1000 + SETTLE_MS;
  return Math.max(MIN_WAIT_MS, Math.min(passMs, ms));
}
