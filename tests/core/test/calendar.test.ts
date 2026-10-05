// Exchange calendar (ROADMAP C6): changes wait out a ≥7-day timelock, the admin can cancel during
// the wait, anyone applies after it, and crosses bound to a calendar must close at a session
// start with an approved oracle feed.
import { describe, expect, it } from 'vitest';
import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  getApplyAdminInstruction,
  getApplyUpdateInstruction,
  getCalendarDecoder,
  getCancelUpdateInstruction,
  getCreateCalendarInstruction,
  getProposeAdminInstruction,
  getProposeUpdateInstruction,
} from '@opening-cross/cross-calendar-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const WEEK = 7n * 24n * 3600n;
const FEED = new Uint8Array(32).fill(7);
const session = (start: bigint) => ({ startTs: start, endTs: start + 6n * 3600n });

async function calendarAddress(admin: Address, id: bigint): Promise<Address> {
  const id8 = new Uint8Array(8);
  new DataView(id8.buffer).setBigUint64(0, id, true);
  return (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(admin), id8] }))[0];
}

async function setup() {
  const w = await World.create();
  const cal = await calendarAddress(w.admin.address, 1n);
  await w.h.send([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 1n, timelockSecs: WEEK, sessions: [session(T0 + 100n), session(T0 + 86_400n)], feeds: [FEED] })], w.admin);
  const read = () => {
    const a = w.h.svm.getAccount(cal);
    if (!a.exists) throw new Error('calendar missing');
    return getCalendarDecoder().decode(a.data);
  };
  return { w, cal, read };
}

describe('exchange calendar', () => {
  it('rejects timelocks under seven days and overlapping sessions', async () => {
    const w = await World.create();
    const cal = await calendarAddress(w.admin.address, 2n);
    expect(await w.h.fail([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 2n, timelockSecs: WEEK - 1n, sessions: [], feeds: [] })], w.admin)).toContain('TimelockTooShort');
    expect(await w.h.fail([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 2n, timelockSecs: WEEK, sessions: [session(T0 + 100n), session(T0 + 200n)], feeds: [] })], w.admin)).toContain('BadSessions');
  });

  it('an update applies only after the timelock, by anyone; the admin can cancel first', async () => {
    const { w, cal, read } = await setup();
    const stranger = await w.trader();
    expect(await w.h.fail([getProposeUpdateInstruction({ admin: stranger, calendar: cal, sessions: [], feeds: [] })], stranger)).toContain('Unauthorized');
    await w.h.send([getProposeUpdateInstruction({ admin: w.admin, calendar: cal, sessions: [session(T0 + 172_800n)], feeds: [] })], w.admin);
    expect(await w.h.fail([getApplyUpdateInstruction({ calendar: cal })], stranger)).toContain('TimelockActive');
    w.h.setTime(T0 + WEEK - 1n);
    expect(await w.h.fail([getApplyUpdateInstruction({ calendar: cal })], stranger)).toContain('TimelockActive');
    w.h.setTime(T0 + WEEK + 1n);
    await w.h.send([getApplyUpdateInstruction({ calendar: cal })], stranger);
    expect(read().sessions.map((s) => s.startTs)).toEqual([T0 + 172_800n]);
    expect(read().feeds.length).toBe(0);

    await w.h.send([getProposeUpdateInstruction({ admin: w.admin, calendar: cal, sessions: [], feeds: [] })], w.admin);
    await w.h.send([getCancelUpdateInstruction({ admin: w.admin, calendar: cal })], w.admin);
    w.h.setTime(T0 + 3n * WEEK);
    expect(await w.h.fail([getApplyUpdateInstruction({ calendar: cal })], stranger)).toContain('NothingPending');
    expect(read().sessions.length).toBe(1);
  });

  it('admin handover is time-locked too', async () => {
    const { w, cal, read } = await setup();
    const next = await w.trader();
    await w.h.send([getProposeAdminInstruction({ admin: w.admin, calendar: cal, newAdmin: next.address })], w.admin);
    expect(await w.h.fail([getApplyAdminInstruction({ calendar: cal })], next)).toContain('TimelockActive');
    w.h.setTime(T0 + WEEK);
    await w.h.send([getApplyAdminInstruction({ calendar: cal })], next);
    expect(read().admin).toBe(next.address);
  });

  it('a calendar cross must close at a session start and use an approved feed', async () => {
    const { w, cal } = await setup();
    const ok = await w.newCross({ calendar: cal, closeTs: T0 + 100n });
    expect(ok.data.calendar).toEqual({ __option: 'Some', value: cal });
    await expect(w.newCross({ calendar: cal, closeTs: T0 + 101n })).rejects.toThrow(/NotACalendarSession/);
    await expect(w.newCross({ calendar: cal, closeTs: T0 + 100n, oracle: { feedId: new Uint8Array(32).fill(9), maxDivergenceBps: 300, maxStalenessSecs: 600 } })).rejects.toThrow(/FeedNotApproved/);
    const withFeed = await w.newCross({ calendar: cal, closeTs: T0 + 100n, oracle: { feedId: FEED, maxDivergenceBps: 300, maxStalenessSecs: 600 } });
    expect(withFeed.data.oracle.__option).toBe('Some');
  });
});
