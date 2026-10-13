import { describe, expect, it } from 'vitest';
import {
  type MarketCalendar,
  REMINDER_KEY,
  REMINDER_LEAD_SECONDS,
  countdown,
  dueReminders,
  explorerAddress,
  hasReminder,
  liveEvents,
  parseReminders,
  readReminders,
  sessionIcs,
  statusAt,
  toggleReminder,
  writeReminders,
} from '../src/lib/calendar-markets';

const T0 = 1_800_000_000;
const sess = (a: number, b: number) => ({ startTs: String(a), endTs: String(b) });
const market = (address: string, schedule: ReturnType<typeof sess>[], over: Partial<MarketCalendar> = {}): MarketCalendar => ({
  address, id: '1', admin: 'admin', timelockSecs: '604800', state: 'closed', halted: false, current: null, next: null, previous: null,
  sessionCount: schedule.length, upcomingSessions: schedule.length, schedule, feeds: [], pendingUpdate: null, pendingAdmin: null, crosses: [], verified: true, indexInSync: true, ...over,
});
const cross = (address: string, state: 'Live' | 'Cleared', closeTs: number, revealEndTs = closeTs) => ({ address, state, closeTs: String(closeTs), revealEndTs: String(revealEndTs), session: sess(closeTs, closeTs + 900), clearingPrice: null, matched: null });

describe('statusAt', () => {
  const m = market('c', [sess(T0 + 100, T0 + 200), sess(T0 + 300, T0 + 400)]);
  it('is closed before a session and names it as next', () => {
    expect(statusAt(m, T0)).toMatchObject({ state: 'closed', current: null, next: m.schedule[0] });
  });
  it('is open from the start second to the second before the end', () => {
    expect(statusAt(m, T0 + 100).state).toBe('open');
    expect(statusAt(m, T0 + 199)).toMatchObject({ state: 'open', current: m.schedule[0], next: m.schedule[1] });
    expect(statusAt(m, T0 + 200)).toMatchObject({ state: 'closed', next: m.schedule[1] });
  });
  it('is closed with nothing next once every session has ended', () => {
    expect(statusAt(m, T0 + 400)).toEqual({ state: 'closed', current: null, next: null });
    expect(statusAt(market('x', []), T0)).toEqual({ state: 'closed', current: null, next: null });
  });
});

describe('liveEvents', () => {
  it('is empty when no calendar has a session ahead and no cross is waiting', () => {
    expect(liveEvents([], T0)).toEqual([]);
    expect(liveEvents([market('a', [sess(T0 - 500, T0 - 100)])], T0)).toEqual([]);
  });
  it('lists a running session first, then the upcoming starts soonest first, with each cross waiting to clear', () => {
    const a = market('a', [sess(T0 - 10, T0 + 50), sess(T0 + 500, T0 + 600)]);
    const b = market('b', [sess(T0 + 100, T0 + 200)], { crosses: [cross('x1', 'Live', T0 + 100), cross('x2', 'Cleared', T0 - 5000)] });
    const kinds = liveEvents([b, a], T0).map((e) => `${e.kind}:${e.calendar}:${e.at}`);
    expect(kinds).toEqual([`session-running:a:${T0 + 50}`, `session-open:b:${T0 + 100}`, `cross-clears:b:${T0 + 100}`, `session-open:a:${T0 + 500}`]);
  });
  it('a finished cross is not an event; a live cross past its time is, flagged due, and sorts before the future', () => {
    const m = market('a', [sess(T0 + 500, T0 + 600)], { crosses: [cross('late', 'Live', T0 - 60), cross('done', 'Finalized' as never, T0 - 60)] });
    const ev = liveEvents([m], T0);
    expect(ev.map((e) => e.kind)).toEqual(['cross-clears', 'session-open']);
    expect(ev[0]).toMatchObject({ cross: 'late', due: true });
  });
  it('caps the upcoming starts one calendar contributes', () => {
    const m = market('a', Array.from({ length: 8 }, (_, i) => sess(T0 + 100 * (i + 1), T0 + 100 * (i + 1) + 50)));
    expect(liveEvents([m], T0)).toHaveLength(3);
    expect(liveEvents([m], T0, { perCalendar: 5 })).toHaveLength(5);
  });
});

describe('countdown', () => {
  it('reads in the two most useful units and never goes negative', () => {
    expect(countdown(9)).toBe('9s');
    expect(countdown(252)).toBe('4m 12s');
    expect(countdown(7_500)).toBe('2h 05m');
    expect(countdown(3 * 86_400 + 4 * 3_600 + 59)).toBe('3d 4h');
    expect(countdown(-30)).toBe('0s');
  });
});

describe('reminders', () => {
  const r = { calendar: 'cal', startTs: T0 + 1000, endTs: T0 + 1900 };
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('toggles one session on and off without touching others', () => {
    const other = { calendar: 'cal', startTs: T0 + 5000, endTs: T0 + 5900 };
    const on = toggleReminder([other], r);
    expect(hasReminder(on, 'cal', r.startTs)).toBe(true);
    expect(toggleReminder(on, r)).toEqual([other]);
  });
  it('round-trips through storage and drops sessions that ended', () => {
    const s = memory();
    expect(writeReminders(s, [r, { calendar: 'cal', startTs: T0 - 900, endTs: T0 - 10 }], T0)).toBe(true);
    expect(readReminders(s)).toEqual([r]);
  });
  it('a store that is missing, throws or holds junk reads as empty and says it could not save', () => {
    expect(readReminders(null)).toEqual([]);
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    expect(readReminders(refusing)).toEqual([]);
    expect(writeReminders(refusing, [r], T0)).toBe(false);
    expect(writeReminders(null, [r], T0)).toBe(false);
    for (const junk of ['{', '"x"', '{"a":1}', '[1,{"calendar":"c"}]', '[{"calendar":"c","startTs":5,"endTs":4}]']) expect(parseReminders(junk)).toEqual([]);
    const s = memory();
    s.setItem(REMINDER_KEY, JSON.stringify([r, { calendar: 5 }]));
    expect(readReminders(s)).toEqual([r]);
  });
  it('is due from ten minutes before the open until the session ends, and not before or after', () => {
    expect(REMINDER_LEAD_SECONDS).toBe(600);
    expect(dueReminders([r], r.startTs - 601)).toEqual([]);
    expect(dueReminders([r], r.startTs - 600)).toEqual([r]);
    expect(dueReminders([r], r.startTs + 5)).toEqual([r]);
    expect(dueReminders([r], r.endTs)).toEqual([]);
  });
});

describe('sessionIcs', () => {
  const text = sessionIcs({ calendar: '4YRGverHdwFRntHPhmHppAFGp4pag5pvVgQX4QHDb7FS', startTs: 1_791_883_766, endTs: 1_791_884_666, url: 'https://example.test/calendar' }, 1_791_883_000);
  const unfolded = text.replace(/\r\n /g, '');
  it('is a single VEVENT over the session, in UTC, with CRLF line ends', () => {
    expect(unfolded).toContain('DTSTART:20261013T092926Z');
    expect(unfolded).toContain('DTEND:20261013T094426Z');
    expect(unfolded).toContain('UID:4YRGverHdwFRntHPhmHppAFGp4pag5pvVgQX4QHDb7FS-1791883766@opening-cross');
    expect(text.split('\r\n').filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(text.endsWith('\r\n')).toBe(true);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  it('refuses a session that does not end after it starts', () => {
    expect(() => sessionIcs({ calendar: 'c', startTs: 10, endTs: 10, url: 'u' })).toThrow(RangeError);
  });
});

describe('explorerAddress', () => {
  it('names the cluster except on mainnet', () => {
    expect(explorerAddress('A', 'devnet')).toBe('https://explorer.solana.com/address/A?cluster=devnet');
    expect(explorerAddress('A', 'mainnet-beta')).toBe('https://explorer.solana.com/address/A');
  });
});
