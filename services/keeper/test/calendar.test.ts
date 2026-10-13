// The calendar trigger: which crosses it watches, how long the keeper sleeps, and how a clearing is attributed to a session.
// Pure: accounts are encoded in memory.
import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner, none, some } from '@solana/kit';
import { CROSS_CALENDAR_PROGRAM_ADDRESS, getCalendarEncoder } from '@opening-cross/cross-calendar-client';
import { CROSS_DISCRIMINATOR, CrossState, getCrossDecoder, getCrossEncoder } from '@opening-cross/cross-core-client';
import { type CalendarWatch, calendarTriggers, createCalendarTrigger, runOnce, wakeDelayMs } from '../src/index.js';

const T0 = 1_800_000_000n;
const HOUR = 3600n;

async function world() {
  const creator = (await generateKeyPairSigner()).address;
  const stranger = (await generateKeyPairSigner()).address;
  const calendar = (await generateKeyPairSigner()).address;
  const accounts = new Map<string, Uint8Array>();
  const sessions = [{ startTs: T0 + HOUR, endTs: T0 + 7n * HOUR }, { startTs: T0 + 24n * HOUR, endTs: T0 + 30n * HOUR }];
  accounts.set(calendar, new Uint8Array(getCalendarEncoder().encode({ admin: creator, id: 1n, timelockSecs: 604_800n, sessions, feeds: [], pending: none(), pendingAdmin: none(), bump: 255 } as never)));
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  const base = getCrossDecoder().decode(z);
  const cross = async (over: Record<string, unknown>) => {
    const a = (await generateKeyPairSigner()).address;
    accounts.set(a, new Uint8Array(getCrossEncoder().encode({ ...base, state: CrossState.Live, baseBound: true, creator, openTs: T0 - 100n, closeTs: sessions[0]!.startTs, revealEndTs: sessions[0]!.startTs, ...over } as never)));
    return a;
  };
  return { creator, stranger, calendar, accounts, sessions, cross };
}

describe('wakeDelayMs', () => {
  const w = (revealEndTs: bigint): CalendarWatch => ({ cross: 'x' as Address, calendar: 'y' as Address, closeTs: revealEndTs, revealEndTs, live: true, session: null });

  it('sleeps the pass interval when nothing is scheduled', () => {
    expect(wakeDelayMs([], T0, 10_000)).toBe(10_000);
  });
  it('sleeps to the boundary, just past it, when it is nearer than a pass', () => {
    expect(wakeDelayMs([w(T0 + 4n)], T0, 10_000)).toBe(4_500);
  });
  it('never sleeps longer than a pass, so new crosses are still found', () => {
    expect(wakeDelayMs([w(T0 + HOUR)], T0, 10_000)).toBe(10_000);
  });
  it('never sleeps under a second, so waiting for the cluster clock to pass the boundary is not a hot loop', () => {
    expect(wakeDelayMs([w(T0 + 1n)], T0, 10_000)).toBeGreaterThanOrEqual(1_000);
  });
  it('a cross that is due and still unsettled is retried at the floor for thirty seconds, then left to the ordinary pass', () => {
    expect(wakeDelayMs([w(T0)], T0, 10_000)).toBe(1_000); // the pass ran into the boundary and could not clear it yet
    expect(wakeDelayMs([w(T0 - 29n)], T0, 10_000)).toBe(1_000);
    expect(wakeDelayMs([w(T0 - 30n)], T0, 10_000)).toBe(10_000);
  });
  it('a cross that is not Live is not waited for', () => {
    expect(wakeDelayMs([{ ...w(T0), live: false }], T0, 10_000)).toBe(10_000);
    expect(wakeDelayMs([{ ...w(T0 + 3n), live: false }], T0, 10_000)).toBe(10_000);
  });
  it('wakes for the earliest of several', () => {
    expect(wakeDelayMs([w(T0 + 8n), w(T0 + 3n), w(T0 - 50n)], T0, 10_000)).toBe(3_500);
  });
});

describe('calendar trigger scan', () => {
  it('watches only calendar-bound crosses of the keeper scope and names the session each closes on', async () => {
    const f = await world();
    const bound = await f.cross({ calendar: some(f.calendar) });
    const plain = await f.cross({});
    const foreign = await f.cross({ calendar: some(f.calendar), creator: f.stranger });
    const finalized = await f.cross({ calendar: some(f.calendar), state: CrossState.Finalized });
    let reads: string[] = [];
    const t = createCalendarTrigger({
      crosses: async () => [bound, plain, foreign, finalized],
      fetch: async (a) => (reads.push(a), f.accounts.get(a) ?? null),
      accept: (c) => c.creator === f.creator,
    });
    const first = await t.scan();
    expect(first.map((x) => x.cross)).toEqual([bound]);
    expect(first[0]).toMatchObject({ calendar: f.calendar, closeTs: f.sessions[0]!.startTs, session: f.sessions[0] });
    // The foreign cross was read once to learn it is out of scope and never again; the plain cross likewise.
    reads = [];
    await t.scan();
    expect(reads).not.toContain(foreign);
    expect(reads).not.toContain(plain);
    expect(reads).toContain(bound);
  });

  it('a cross whose calendar no longer lists its close as a session start is still watched, with no session named', async () => {
    const f = await world();
    const orphan = await f.cross({ calendar: some(f.calendar), closeTs: T0 + 2n * HOUR, revealEndTs: T0 + 2n * HOUR });
    const [w] = await createCalendarTrigger({ crosses: async () => [orphan], fetch: async (a) => f.accounts.get(a) ?? null }).scan();
    expect(w).toMatchObject({ cross: orphan, session: null });
  });

  it('a calendar account that is missing or is not a calendar names no session and does not fail the scan', async () => {
    const f = await world();
    const c = await f.cross({ calendar: some(f.calendar) });
    f.accounts.set(f.calendar, new Uint8Array(64));
    const [w] = await createCalendarTrigger({ crosses: async () => [c], fetch: async (a) => f.accounts.get(a) ?? null }).scan();
    expect(w!.session).toBeNull();
    f.accounts.delete(f.calendar);
    const [w2] = await createCalendarTrigger({ crosses: async () => [c], fetch: async (a) => f.accounts.get(a) ?? null }).scan();
    expect(w2!.session).toBeNull();
  });
});

describe('a calendar-bound cross at its boundary', () => {
  it('is not touched before the session starts, and is settled once it does, attributed to the session', async () => {
    const f = await world();
    const c = await f.cross({ calendar: some(f.calendar) });
    const sent: string[] = [];
    let now = f.sessions[0]!.startTs - 1n;
    const discovery = { crosses: async () => [c], fetch: async (a: Address) => f.accounts.get(a) ?? null };
    const trigger = createCalendarTrigger(discovery);
    const pass = async () => {
      const watches = await trigger.scan();
      const res = await runOnce({ payer: await generateKeyPairSigner(), now: async () => now, orders: async () => [], send: async () => (sent.push('tx'), 'sig'), ...discovery });
      return { watches, res, triggers: calendarTriggers(res, watches) };
    };
    const before = await pass();
    expect(before.res.done).toEqual([]);
    expect(before.triggers).toEqual([]);
    expect(wakeDelayMs(before.watches, now, 10_000)).toBe(1_500);
    now = f.sessions[0]!.startTs;
    const at = await pass();
    expect(at.res.done[0]!.action).toMatchObject({ kind: 'settle', cross: c });
    expect(at.triggers).toEqual([{ cross: c, calendar: f.calendar, sessionStartTs: f.sessions[0]!.startTs, clearAfterTs: f.sessions[0]!.startTs, signature: 'sig' }]);
  });

  it('a sealed cross waits for its reveal window, not just the session start', async () => {
    const f = await world();
    const c = await f.cross({ calendar: some(f.calendar), revealEndTs: f.sessions[0]!.startTs + 600n });
    const watches = await createCalendarTrigger({ crosses: async () => [c], fetch: async (a) => f.accounts.get(a) ?? null }).scan();
    expect(wakeDelayMs(watches, f.sessions[0]!.startTs, 10_000)).toBe(10_000); // 600 s away: a pass is nearer
    expect(wakeDelayMs(watches, f.sessions[0]!.startTs + 597n, 10_000)).toBe(3_500);
  });
});

describe('calendar program identity', () => {
  it('the client the keeper tests encode with points at the deployed program', () => {
    expect(CROSS_CALENDAR_PROGRAM_ADDRESS).toBe('CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN');
  });
});
