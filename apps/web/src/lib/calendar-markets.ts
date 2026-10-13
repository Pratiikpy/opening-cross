// Market sessions from GET /v1/calendar (services/api/src/routes/calendar.ts): what a calendar is doing by the clock, the
// calendar-driven events the live page counts down to, and the in-browser reminders. Pure and free of React, so every rule
// is unit-tested. Nothing here is a default or a guess: a calendar with no session ahead produces no event.
import { escapeText, foldLine, icsUtc } from './ics';

export type MarketSession = { startTs: string; endTs: string };

export type MarketCross = {
  address: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  closeTs: string;
  revealEndTs: string;
  /** The session this cross closes on; null when the calendar no longer lists that start. */
  session: MarketSession | null;
  clearingPrice: string | null;
  matched: string | null;
};

export type MarketCalendar = {
  address: string;
  id: string;
  admin: string;
  timelockSecs: string;
  /** `open` while a session is running, else `closed`: the only two states the calendar program defines. */
  state: 'open' | 'closed';
  /** True while cross_core's protocol-wide pause is on (it stops new crosses and orders; clearing and refunds are never paused). */
  halted: boolean;
  current: MarketSession | null;
  next: MarketSession | null;
  previous: MarketSession | null;
  sessionCount: number;
  upcomingSessions: number;
  /** The sessions that have not ended yet, soonest first (at most ten). */
  schedule: MarketSession[];
  feeds: string[];
  pendingUpdate: { sessions: MarketSession[]; feeds: string[]; eta: string; appliesInSeconds: string } | null;
  pendingAdmin: { admin: string; eta: string } | null;
  crosses: MarketCross[];
  /** The calendar was read from chain for this response. */
  verified: boolean;
  indexInSync: boolean | null;
};

export type MarketsResponse = { network: string; asOf: string; protocolPaused: boolean | null; calendars: MarketCalendar[] };

export type Status = { state: 'open' | 'closed'; current: MarketSession | null; next: MarketSession | null };

const n = (v: string) => Number(v);

/** Where the calendar stands at `now`, from the sessions the API sent. Matches the API's own rule: open from the start second to the one before the end. */
export function statusAt(m: Pick<MarketCalendar, 'schedule'>, now: number): Status {
  let current: MarketSession | null = null;
  let next: MarketSession | null = null;
  for (const s of m.schedule) {
    if (n(s.startTs) <= now && now < n(s.endTs)) current = s;
    else if (n(s.startTs) > now && next === null) next = s;
  }
  return { state: current ? 'open' : 'closed', current, next };
}

export type LiveEvent =
  | { kind: 'session-open'; key: string; calendar: string; at: number; endTs: number }
  | { kind: 'session-running'; key: string; calendar: string; at: number; endTs: number }
  | { kind: 'cross-clears'; key: string; calendar: string; at: number; cross: string; sessionStartTs: number | null; due: boolean };

/**
 * The calendar-driven events at `now`, soonest first, running sessions before upcoming ones:
 *   - a running session (counts down to its end),
 *   - every upcoming session start (counts down to the open),
 *   - every still-collecting cross scheduled on a calendar (counts down to the moment it clears; `due` once that has passed
 *     and the keeper or anyone else has not cleared it yet).
 * `perCalendar` caps how many upcoming session starts one calendar contributes, so a calendar with sixty-four sessions does not flood the page.
 */
export function liveEvents(markets: readonly MarketCalendar[], now: number, opts: { perCalendar?: number } = {}): LiveEvent[] {
  const per = opts.perCalendar ?? 3;
  const out: LiveEvent[] = [];
  for (const m of markets) {
    const s = statusAt(m, now);
    if (s.current) out.push({ kind: 'session-running', key: `run:${m.address}:${s.current.startTs}`, calendar: m.address, at: n(s.current.endTs), endTs: n(s.current.endTs) });
    for (const x of m.schedule.filter((x) => n(x.startTs) > now).slice(0, per)) {
      out.push({ kind: 'session-open', key: `open:${m.address}:${x.startTs}`, calendar: m.address, at: n(x.startTs), endTs: n(x.endTs) });
    }
    for (const c of m.crosses) {
      if (c.state !== 'Live') continue;
      const at = n(c.revealEndTs);
      out.push({ kind: 'cross-clears', key: `clear:${c.address}`, calendar: m.address, at, cross: c.address, sessionStartTs: c.session ? n(c.session.startTs) : null, due: at <= now });
    }
  }
  const rank = (e: LiveEvent) => (e.kind === 'session-running' ? 0 : e.kind === 'cross-clears' && e.due ? 1 : 2);
  // At the same instant the session opening is listed before the cross that clears because of it.
  const order = (e: LiveEvent) => (e.kind === 'cross-clears' ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || a.at - b.at || order(a) - order(b) || (a.key < b.key ? -1 : 1));
}

/** `4m 12s`, `2h 05m`, `3d 4h`: how long until `seconds` from now. Never negative. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

export const shortKey = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export const explorerAddress = (a: string, network: string): string => `https://explorer.solana.com/address/${a}${network === 'mainnet-beta' ? '' : `?cluster=${network === 'localnet' ? 'custom' : network}`}`;

// ------------------------------------------------------------------------------------------------ reminders

/** A reminder stored in this browser for one session of one calendar. Nothing is sent to us: it lives in localStorage. */
export type Reminder = { calendar: string; startTs: number; endTs: number };

export const REMINDER_KEY = 'opening-bell.calendar.reminders.v1';
/** A reminder shows from this long before the session opens. */
export const REMINDER_LEAD_SECONDS = 600;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const valid = (r: unknown): r is Reminder =>
  typeof r === 'object' && r !== null && typeof (r as Reminder).calendar === 'string' && Number.isSafeInteger((r as Reminder).startTs) && Number.isSafeInteger((r as Reminder).endTs) && (r as Reminder).endTs > (r as Reminder).startTs;

/** The reminders in a stored string; anything that is not a list of well-formed reminders yields an empty list. */
export function parseReminders(raw: string | null | undefined): Reminder[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

/** Reads the stored reminders; storage that is missing or blocked yields an empty list. */
export function readReminders(store: Store | null | undefined): Reminder[] {
  try {
    return parseReminders(store?.getItem(REMINDER_KEY));
  } catch {
    return [];
  }
}

/** Writes the list, dropping reminders for sessions that ended. Returns false when the browser refused (private mode, quota). */
export function writeReminders(store: Store | null | undefined, list: readonly Reminder[], now: number): boolean {
  try {
    store?.setItem(REMINDER_KEY, JSON.stringify(list.filter((r) => r.endTs > now)));
    return Boolean(store);
  } catch {
    return false;
  }
}

export const hasReminder = (list: readonly Reminder[], calendar: string, startTs: number) => list.some((r) => r.calendar === calendar && r.startTs === startTs);

export function toggleReminder(list: readonly Reminder[], r: Reminder): Reminder[] {
  return hasReminder(list, r.calendar, r.startTs) ? list.filter((x) => !(x.calendar === r.calendar && x.startTs === r.startTs)) : [...list, r];
}

/** Reminders that should be on screen at `now`: from ten minutes before the open until the session ends. */
export function dueReminders(list: readonly Reminder[], now: number): Reminder[] {
  return list.filter((r) => now >= r.startTs - REMINDER_LEAD_SECONDS && now < r.endTs).sort((a, b) => a.startTs - b.startTs);
}

// ------------------------------------------------------------------------------------------------ ics

/** A one-event .ics for the start of a market session. The event runs for the session itself. */
export function sessionIcs(e: { calendar: string; startTs: number; endTs: number; url: string }, now: number = Math.floor(Date.now() / 1000)): string {
  if (!Number.isSafeInteger(e.startTs) || !Number.isSafeInteger(e.endTs) || e.endTs <= e.startTs) throw new RangeError('a session must end after it starts');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Opening Bell//Opening Cross market calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.calendar}-${e.startTs}@opening-cross`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(e.startTs)}`,
    `DTEND:${icsUtc(e.endTs)}`,
    `SUMMARY:${escapeText(`Market session opens (calendar ${shortKey(e.calendar)})`)}`,
    `DESCRIPTION:${escapeText(`A session published on the Opening Cross calendar ${e.calendar}. Reopen crosses scheduled on it clear at the start of this event. Devnet only. ${e.url}`)}`,
    `URL:${e.url}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
