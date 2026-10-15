// cross_calendar on a Surfpool surfnet. The calendar changes only through a seven-day timelock, which a test on a live cluster cannot wait
// for: here the surfnet's clock is moved past it. Every instruction of the program is driven with real transactions, each refusal is
// read with the program's own error number, and every state change is read back from the calendar account.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type KeyPairSigner, fetchEncodedAccount, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
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
import { airdrop, chainTime, deployProgram, refusal, rpc, send, show, travelTo } from '../src/surfnet.js';
import { world } from '../src/world.js';

const Err = { TimelockTooShort: 6000, TooMany: 6001, BadSessions: 6002, NothingPending: 6003, TimelockActive: 6004, Unauthorized: 6005 } as const;
const WEEK = 7n * 24n * 3600n;

async function calendarAddress(admin: Address, id: bigint): Promise<Address> {
  const id8 = new Uint8Array(8);
  new DataView(id8.buffer).setBigUint64(0, id, true);
  return (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(admin), id8] }))[0];
}
const read = async (address: Address) => {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing ${address}`);
  return getCalendarDecoder().decode(a.data);
};
const sessionsFrom = (start: bigint, n: number) => Array.from({ length: n }, (_, i) => ({ startTs: start + BigInt(i) * 86_400n, endTs: start + BigInt(i) * 86_400n + 900n }));

describe('cross_calendar on a surfnet', () => {
  let admin: KeyPairSigner;
  let stranger: KeyPairSigner;
  beforeAll(async () => {
    const w = await world();
    admin = w.operator;
    await deployProgram(CROSS_CALENDAR_PROGRAM_ADDRESS, 'cross_calendar');
    stranger = await generateKeyPairSigner();
    await airdrop(stranger.address, 5);
  });

  it('refuses a calendar with a timelock under seven days, overlapping or unordered sessions, and too many sessions or feeds', async () => {
    const t = await chainTime();
    const id = BigInt(Date.now());
    const cal = await calendarAddress(admin.address, id);
    const make = (o: { timelockSecs?: bigint; sessions?: { startTs: bigint; endTs: bigint }[]; feeds?: Uint8Array[] }) => getCreateCalendarInstruction({ admin, calendar: cal, id, timelockSecs: o.timelockSecs ?? WEEK, sessions: o.sessions ?? sessionsFrom(t + 1000n, 2), feeds: o.feeds ?? [] });
    expect((await refusal([make({ timelockSecs: WEEK - 1n })], admin)).custom).toBe(Err.TimelockTooShort);
    expect((await refusal([make({ sessions: [{ startTs: t + 2000n, endTs: t + 2900n }, { startTs: t + 1000n, endTs: t + 1900n }] })], admin)).custom, 'out of order').toBe(Err.BadSessions);
    expect((await refusal([make({ sessions: [{ startTs: t + 1000n, endTs: t + 2000n }, { startTs: t + 1500n, endTs: t + 2500n }] })], admin)).custom, 'overlapping').toBe(Err.BadSessions);
    expect((await refusal([make({ sessions: [{ startTs: t + 1000n, endTs: t + 1000n }] })], admin)).custom, 'a session that ends when it starts').toBe(Err.BadSessions);
    // 65 sessions (the first over the limit of 64) is 1,040 bytes of arguments and does not fit in a transaction (1,232 bytes), so the
    // session limit cannot be exercised through a transaction at all; the feeds limit can.
    expect((await refusal([make({ feeds: Array.from({ length: 9 }, (_, i) => new Uint8Array(32).fill(i + 1)) })], admin)).custom, '9 feeds').toBe(Err.TooMany);
  });

  it('creates a calendar that holds exactly what was given, and refuses a second one at the same address', async () => {
    const t = await chainTime();
    const id = BigInt(Date.now()) + 1n;
    const cal = await calendarAddress(admin.address, id);
    const sessions = sessionsFrom(t + 1000n, 3);
    const feed = new Uint8Array(32).fill(7);
    const ix = getCreateCalendarInstruction({ admin, calendar: cal, id, timelockSecs: WEEK + 60n, sessions, feeds: [feed] });
    await send([ix], admin);
    const c = await read(cal);
    expect([c.admin, c.id, c.timelockSecs, c.sessions.length, c.feeds.length, c.pending.__option, c.pendingAdmin.__option]).toEqual([admin.address, id, WEEK + 60n, 3, 1, 'None', 'None']);
    expect(c.sessions.map((s) => [s.startTs, s.endTs])).toEqual(sessions.map((s) => [s.startTs, s.endTs]));
    const again = await refusal([ix], admin);
    // The system program refuses to create an account that exists: its error 0, "account already in use".
    expect(again.logs.some((l) => l.includes('Program 11111111111111111111111111111111 failed')), show(again.logs.slice(-3))).toBe(true);
    expect(again.custom).toBe(0);
  });

  it('applies a proposed update only after its timelock, changes nothing before, and lets anyone apply it', async () => {
    const t = await chainTime();
    const id = BigInt(Date.now()) + 2n;
    const cal = await calendarAddress(admin.address, id);
    await send([getCreateCalendarInstruction({ admin, calendar: cal, id, timelockSecs: WEEK, sessions: sessionsFrom(t + 1000n, 2), feeds: [] })], admin);
    const next = sessionsFrom(t + 5n * 86_400n, 4);

    expect((await refusal([getApplyUpdateInstruction({ calendar: cal })], stranger)).custom, 'nothing proposed yet').toBe(Err.NothingPending);
    expect((await refusal([getProposeUpdateInstruction({ admin: stranger, calendar: cal, sessions: next, feeds: [] })], stranger)).custom, 'a stranger cannot propose').toBe(Err.Unauthorized);
    expect((await refusal([getProposeUpdateInstruction({ admin, calendar: cal, sessions: [{ startTs: 5n, endTs: 4n }], feeds: [] })], admin)).custom, 'a bad proposal is refused up front').toBe(Err.BadSessions);

    await send([getProposeUpdateInstruction({ admin, calendar: cal, sessions: next, feeds: [new Uint8Array(32).fill(9)] })], admin);
    const proposed = await read(cal);
    expect(proposed.pending.__option).toBe('Some');
    const eta = proposed.pending.__option === 'Some' ? proposed.pending.value.eta : 0n;
    expect(eta - (await chainTime())).toBeGreaterThan(WEEK - 60n);
    expect(proposed.sessions.length, 'the live calendar is unchanged while the proposal waits').toBe(2);

    expect((await refusal([getApplyUpdateInstruction({ calendar: cal })], stranger)).custom, 'before the timelock').toBe(Err.TimelockActive);
    await travelTo(eta - 10n);
    expect((await refusal([getApplyUpdateInstruction({ calendar: cal })], stranger)).custom, 'ten seconds early').toBe(Err.TimelockActive);
    await travelTo(eta + 1n);
    await send([getApplyUpdateInstruction({ calendar: cal })], stranger);
    const applied = await read(cal);
    expect([applied.sessions.length, applied.feeds.length, applied.pending.__option]).toEqual([4, 1, 'None']);
    expect(applied.sessions.map((s) => s.startTs)).toEqual(next.map((s) => s.startTs));
    expect((await refusal([getApplyUpdateInstruction({ calendar: cal })], stranger)).custom, 'applied once').toBe(Err.NothingPending);
  });

  it('lets the admin cancel a proposal during the wait, and only the admin', async () => {
    const t = await chainTime();
    const id = BigInt(Date.now()) + 3n;
    const cal = await calendarAddress(admin.address, id);
    await send([getCreateCalendarInstruction({ admin, calendar: cal, id, timelockSecs: WEEK, sessions: sessionsFrom(t + 1000n, 2), feeds: [] })], admin);
    expect((await refusal([getCancelUpdateInstruction({ admin, calendar: cal })], admin)).custom, 'nothing to cancel').toBe(Err.NothingPending);
    await send([getProposeUpdateInstruction({ admin, calendar: cal, sessions: sessionsFrom(t + 9n * 86_400n, 1), feeds: [] })], admin);
    expect((await refusal([getCancelUpdateInstruction({ admin: stranger, calendar: cal })], stranger)).custom).toBe(Err.Unauthorized);
    await send([getCancelUpdateInstruction({ admin, calendar: cal })], admin);
    const c = await read(cal);
    expect([c.pending.__option, c.sessions.length]).toEqual(['None', 2]);
    await travelTo((await chainTime()) + WEEK + 10n);
    expect((await refusal([getApplyUpdateInstruction({ calendar: cal })], stranger)).custom, 'a cancelled proposal never applies').toBe(Err.NothingPending);
  });

  it('hands the calendar to a new admin through the same timelock, after which the old admin has no power', async () => {
    const t = await chainTime();
    const id = BigInt(Date.now()) + 4n;
    const cal = await calendarAddress(admin.address, id);
    await send([getCreateCalendarInstruction({ admin, calendar: cal, id, timelockSecs: WEEK, sessions: sessionsFrom(t + 1000n, 1), feeds: [] })], admin);
    const heir = await generateKeyPairSigner();
    await airdrop(heir.address, 2);
    expect((await refusal([getProposeAdminInstruction({ admin: stranger, calendar: cal, newAdmin: heir.address })], stranger)).custom).toBe(Err.Unauthorized);
    expect((await refusal([getApplyAdminInstruction({ calendar: cal })], stranger)).custom, 'no handover pending').toBe(Err.NothingPending);
    await send([getProposeAdminInstruction({ admin, calendar: cal, newAdmin: heir.address })], admin);
    const pending = (await read(cal)).pendingAdmin;
    expect(pending.__option).toBe('Some');
    expect((await refusal([getApplyAdminInstruction({ calendar: cal })], stranger)).custom, 'before the timelock').toBe(Err.TimelockActive);
    await travelTo((pending.__option === 'Some' ? pending.value.eta : 0n) + 1n);
    await send([getApplyAdminInstruction({ calendar: cal })], stranger);
    const c = await read(cal);
    expect([c.admin, c.pendingAdmin.__option]).toEqual([heir.address, 'None']);
    expect((await refusal([getProposeUpdateInstruction({ admin, calendar: cal, sessions: sessionsFrom(t + 3_000_000n, 1), feeds: [] })], admin)).custom, 'the old admin').toBe(Err.Unauthorized);
    await send([getProposeUpdateInstruction({ admin: heir, calendar: cal, sessions: sessionsFrom(t + 3_000_000n, 1), feeds: [] })], heir);
    expect((await read(cal)).pending.__option, 'the new admin').toBe('Some');
  });
});
