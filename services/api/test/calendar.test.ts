// cross_calendar off-chain: session status, event attribution, the indexer's projection and reconciler (Postgres), and the two
// /v1/calendar routes over HTTP with accounts injected in memory. The Postgres part needs DATABASE_URL (each run uses and then
// drops its own schema); the pure parts always run.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { type Address, generateKeyPairSigner, none, some } from '@solana/kit';
import {
  CALENDAR_DISCRIMINATOR,
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  getCalendarAdminChangedEventEncoder,
  getCalendarEncoder,
  getCalendarUpdatedEventEncoder,
  getUpdateProposedEventEncoder,
} from '@opening-cross/cross-calendar-client';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, getCrossDecoder, getCrossEncoder, getProtocolEncoder, protocolAddress } from '@opening-cross/sdk';
import {
  type CalendarRow,
  UnattributableCalendarLogs,
  bindCrosses,
  calendarCandidates,
  calendarFromAccount,
  canonicalJson,
  decodeCalendarLogs,
  ingestCalendarTransaction,
  migrate,
  reconcileCalendars,
  sessionStartingAt,
  sessionStatus,
} from '@opening-cross/indexer';
import { buildServer } from '../src/server.js';

const OTHER = '7Kb2feBGE34ck7F7dovaEgKVJRLJ2JeUFxCyo4bamZJD';
const T0 = 1_800_000_000n;
const H = 3600n;
const sess = (a: bigint, b: bigint) => ({ startTs: a, endTs: b });
const data = (bytes: Uint8Array | ReadonlyUint8ArrayLike) => `Program data: ${Buffer.from(bytes as Uint8Array).toString('base64')}`;
type ReadonlyUint8ArrayLike = ArrayLike<number>;
const wrap = (program: string, lines: string[]) => [`Program ${program} invoke [1]`, ...lines, `Program ${program} success`];

function calendarBytes(over: Record<string, unknown> = {}, admin = OTHER as Address) {
  return new Uint8Array(
    getCalendarEncoder().encode({
      admin, id: 7n, timelockSecs: 604_800n, sessions: [sess(T0 + H, T0 + 7n * H), sess(T0 + 24n * H, T0 + 30n * H)], feeds: [new Uint8Array(32).fill(7)],
      pending: none(), pendingAdmin: none(), bump: 254, ...over,
    } as never),
  );
}

describe('sessionStatus', () => {
  const s = [sess(100n, 200n), sess(300n, 400n)];
  it('is closed before the first session, with the first as next', () => {
    expect(sessionStatus(s, 50n)).toEqual({ state: 'closed', current: null, next: s[0], previous: null });
  });
  it('is open from the start second to the second before the end', () => {
    expect(sessionStatus(s, 100n).state).toBe('open');
    expect(sessionStatus(s, 199n)).toMatchObject({ state: 'open', current: s[0], next: s[1] });
    expect(sessionStatus(s, 200n)).toMatchObject({ state: 'closed', current: null, previous: s[0], next: s[1] });
  });
  it('is closed with nothing next after the last session', () => {
    expect(sessionStatus(s, 400n)).toEqual({ state: 'closed', current: null, next: null, previous: s[1] });
    expect(sessionStatus([], 400n)).toEqual({ state: 'closed', current: null, next: null, previous: null });
  });
  it('finds the session a cross closes on only by its exact start', () => {
    expect(sessionStartingAt(s, 300n)).toBe(s[1]);
    expect(sessionStartingAt(s, 301n)).toBeNull();
  });
});

describe('calendar event attribution', () => {
  const cal = OTHER as Address;
  const updated = data(getCalendarUpdatedEventEncoder().encode({ calendar: cal, sessions: 2, feeds: 1 }));

  it('decodes each event written by cross_calendar', () => {
    const logs = wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, [
      updated,
      data(getUpdateProposedEventEncoder().encode({ calendar: cal, eta: 99n })),
      data(getCalendarAdminChangedEventEncoder().encode({ calendar: cal, admin: cal })),
    ]);
    expect(decodeCalendarLogs(logs).map((e) => e.name)).toEqual(['CalendarUpdated', 'UpdateProposed', 'CalendarAdminChanged']);
    expect(decodeCalendarLogs(logs)[0]!.calendar).toBe(cal);
  });
  it('ignores an identical payload written by another program', () => {
    expect(decodeCalendarLogs(wrap(OTHER, [updated]))).toEqual([]);
    expect(decodeCalendarLogs([`Program ${OTHER} invoke [1]`, `Program ${CROSS_CALENDAR_PROGRAM_ADDRESS} invoke [2]`, `Program ${CROSS_CALENDAR_PROGRAM_ADDRESS} success`, updated, `Program ${OTHER} success`])).toEqual([]);
  });
  it('does not read the pre-upgrade AdminChanged payload (same discriminator as cross_core) as a calendar event', () => {
    const old = Buffer.concat([Buffer.from('e8221fe23e121372', 'hex'), Buffer.alloc(64)]);
    expect(decodeCalendarLogs(wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, [data(old)]))).toEqual([]);
  });
  it('refuses truncated or unbalanced logs instead of guessing', () => {
    expect(() => decodeCalendarLogs([`Program ${CROSS_CALENDAR_PROGRAM_ADDRESS} invoke [1]`, 'Log truncated'])).toThrow(UnattributableCalendarLogs);
    expect(() => decodeCalendarLogs([`Program ${CROSS_CALENDAR_PROGRAM_ADDRESS} invoke [1]`, `Program ${OTHER} success`])).toThrow(UnattributableCalendarLogs);
  });
  it('finds the calendar a transaction changed from the instruction accounts, not only from events', () => {
    const keys = ['admin', 'calendar', CROSS_CALENDAR_PROGRAM_ADDRESS, 'other', 'lut-writable'];
    const tx = {
      transaction: { message: { accountKeys: keys.slice(0, 4), instructions: [{ programIdIndex: 2, accounts: [0, 1], data: '' }, { programIdIndex: 3, accounts: [0], data: '' }] } },
      meta: { loadedAddresses: { writable: ['lut-writable'], readonly: [] } },
    };
    expect(calendarCandidates(tx)).toEqual(['admin', 'calendar']);
  });
});

describe('calendarFromAccount', () => {
  it('reads a Calendar owned by the program', () => {
    const row = calendarFromAccount('cal', { data: calendarBytes({ pending: some({ sessions: [sess(T0 + 40n * H, T0 + 46n * H)], feeds: [], eta: T0 + 9n * 24n * H }) }), owner: CROSS_CALENDAR_PROGRAM_ADDRESS })!;
    expect(row.calendar_id).toBe('7');
    expect(row.sessions).toHaveLength(2);
    expect(row.feeds[0]).toBe('07'.repeat(32));
    expect(row.pending).toMatchObject({ eta: String(T0 + 9n * 24n * H) });
    expect(row.pending_admin).toBeNull();
  });
  it('refuses a look-alike under another owner, a wrong discriminator and garbage', () => {
    expect(calendarFromAccount('cal', { data: calendarBytes(), owner: OTHER })).toBeNull();
    const wrong = calendarBytes();
    wrong[0] ^= 0xff;
    expect(calendarFromAccount('cal', { data: wrong, owner: CROSS_CALENDAR_PROGRAM_ADDRESS })).toBeNull();
    const garbage = new Uint8Array(40);
    garbage.set(CALENDAR_DISCRIMINATOR as Uint8Array, 0);
    expect(calendarFromAccount('cal', { data: garbage, owner: CROSS_CALENDAR_PROGRAM_ADDRESS })).toBeNull();
  });
  it('canonicalJson ignores key order, which JSONB does not keep', () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
    expect(canonicalJson(null)).toBe('null');
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn('calendar.test.ts: the Postgres and HTTP parts are SKIPPED; set DATABASE_URL to a Postgres to run them');

describe.skipIf(!url)('calendar indexer and routes against Postgres', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let db: pg.Pool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const chain = new Map<string, { data: Uint8Array; owner: Address }>();
  let calA: Address;
  let calB: Address;
  let crossBound: Address;
  let crossPlain: Address;
  let clock = Number(T0);
  let slot = 1_000n;

  const read = async (addresses: readonly string[]) => ({ slot, accounts: new Map(addresses.map((a) => [a, chain.get(a) ?? null])) });
  const tx = (signature: string, logs: string[], candidates: string[], err: unknown = null) => ({ signature, slot: ++slot, blockTime: T0, logs, err, candidates });
  const putCal = (a: Address, over: Record<string, unknown> = {}) => chain.set(a, { data: calendarBytes(over), owner: CROSS_CALENDAR_PROGRAM_ADDRESS });

  const crossAccount = async (over: Record<string, unknown>) => {
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const a = (await generateKeyPairSigner()).address;
    chain.set(a, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), priceScale: 1_000_000n, ...over } as never)) });
    return a;
  };
  const insertCross = (a: string, state: string, close: bigint) =>
    db.query(
      `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
       VALUES ($1,'c',0,1,1,'b','q',$2,$3,$3,0,0,$4,1,1)`,
      [a, (close - 100n).toString(), close.toString(), state],
    );
  const get = async (path: string) => {
    const res = await app.inject({ method: 'GET', url: path });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(db);
    [calA, calB] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    chain.set(await protocolAddress(), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getProtocolEncoder().encode({ admin: OTHER, guardian: OTHER, feeRecipient: OTHER, feeBps: [0, 0, 0, 0], paused: false, bump: 255, pendingAdmin: none() } as never)) });
    app = await buildServer({
      db,
      network: 'devnet',
      clock: () => clock,
      account: async (a) => chain.get(a) ?? null,
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
      // The tests change the chain between two requests, so no calendar read may be reused.
      calendarChainTtlMs: 0,
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('a creation transaction stores the calendar as the chain holds it, and its event', async () => {
    putCal(calA);
    const n = await ingestCalendarTransaction(db, tx('sig-create', wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, [data(getCalendarUpdatedEventEncoder().encode({ calendar: calA, sessions: 2, feeds: 1 }))]), [OTHER, calA]), read);
    expect(n).toBe(1);
    const { rows } = await db.query('SELECT * FROM calendars WHERE address = $1', [calA]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admin: OTHER, calendar_id: '7', timelock_secs: '604800' });
    expect(rows[0].sessions[0]).toEqual({ startTs: String(T0 + H), endTs: String(T0 + 7n * H) });
    // The admin account was a candidate too and is not a calendar: nothing is stored for it.
    expect((await db.query('SELECT count(*)::int AS n FROM calendars')).rows[0].n).toBe(1);
  });

  it('ingesting the same signature again changes nothing', async () => {
    const again = await ingestCalendarTransaction(db, { ...tx('sig-create', wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, [data(getCalendarUpdatedEventEncoder().encode({ calendar: calA, sessions: 2, feeds: 1 }))]), [calA]), slot: 1_001n }, read);
    expect(again).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM calendar_events')).rows[0].n).toBe(1);
  });

  it('propose_admin emits no event, yet its transaction still refreshes the calendar', async () => {
    putCal(calA, { pendingAdmin: some({ admin: calB, eta: T0 + 8n * 24n * H }) });
    const n = await ingestCalendarTransaction(db, tx('sig-propose-admin', wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, ['Program log: Instruction: ProposeAdmin']), [OTHER, calA]), read);
    expect(n).toBe(0);
    const { rows } = await db.query('SELECT pending_admin FROM calendars WHERE address = $1', [calA]);
    expect(rows[0].pending_admin).toEqual({ admin: calB, eta: String(T0 + 8n * 24n * H) });
  });

  it('a failed transaction changes nothing, whatever it logged', async () => {
    putCal(calA, { id: 99n });
    const n = await ingestCalendarTransaction(db, tx('sig-failed', wrap(CROSS_CALENDAR_PROGRAM_ADDRESS, [data(getCalendarUpdatedEventEncoder().encode({ calendar: calA, sessions: 2, feeds: 1 }))]), [calA], { InstructionError: [0, 'Custom'] }), read);
    expect(n).toBe(0);
    expect((await db.query('SELECT calendar_id FROM calendars WHERE address = $1', [calA])).rows[0].calendar_id).toBe('7');
    putCal(calA, { pendingAdmin: some({ admin: calB, eta: T0 + 8n * 24n * H }) });
  });

  it('the reconciler reports a calendar the index never saw and one that drifted, repairs both, and then finds none', async () => {
    putCal(calB, { id: 8n, sessions: [sess(T0 + 50n * H, T0 + 56n * H)] });
    putCal(calA, { timelockSecs: 700_000n, pendingAdmin: some({ admin: calB, eta: T0 + 8n * 24n * H }) });
    const scan = async () => ({ slot: 2_000n, calendars: [...chain].map(([a, v]) => calendarFromAccount(a, v)).filter((r): r is CalendarRow => r !== null) });
    const drift = await reconcileCalendars(db, scan, { record: true, repair: true });
    expect(drift).toEqual(
      expect.arrayContaining([
        { calendar: calB, field: 'exists', indexed: null, onchain: 'true' },
        { calendar: calA, field: 'timelock_secs', indexed: '604800', onchain: '700000' },
      ]),
    );
    expect(drift).toHaveLength(2);
    expect((await db.query('SELECT count(*)::int AS n FROM calendar_reconciliation_alerts')).rows[0].n).toBe(2);
    expect(await reconcileCalendars(db, scan, { repair: true })).toEqual([]);
  });

  it('a calendar gone from chain is reported and kept, not deleted', async () => {
    const gone = (await generateKeyPairSigner()).address;
    await db.query(`INSERT INTO calendars (address, admin, calendar_id, timelock_secs, sessions, feeds, first_slot, read_slot) VALUES ($1,'a',1,1,'[]','[]',1,1)`, [gone]);
    const drift = await reconcileCalendars(db, async () => ({ slot: 3_000n, calendars: [] }));
    expect(drift).toContainEqual({ calendar: gone, field: 'exists', indexed: 'true', onchain: null });
    expect((await db.query('SELECT 1 FROM calendars WHERE address = $1', [gone])).rowCount).toBe(1);
    await db.query('DELETE FROM calendars WHERE address = $1', [gone]);
  });

  it('records which calendar a cross is bound to, from the Cross account, once', async () => {
    crossBound = await crossAccount({ state: CrossState.Live, calendar: some(calA), closeTs: T0 + H, revealEndTs: T0 + H });
    crossPlain = await crossAccount({ state: CrossState.Live, calendar: none(), closeTs: T0 + 5n * H, revealEndTs: T0 + 5n * H });
    await insertCross(crossBound, 'Live', T0 + H);
    await insertCross(crossPlain, 'Live', T0 + 5n * H);
    expect(await bindCrosses(db, read, CROSS_CORE_PROGRAM_ADDRESS)).toEqual({ bound: 2, remaining: 0 });
    const { rows } = await db.query('SELECT cross_address, calendar FROM cross_calendar_binding ORDER BY calendar NULLS LAST');
    expect(rows).toEqual([{ cross_address: crossBound, calendar: calA }, { cross_address: crossPlain, calendar: null }]);
    expect(await bindCrosses(db, read, CROSS_CORE_PROGRAM_ADDRESS)).toEqual({ bound: 0, remaining: 0 });
  });

  it('a cross whose account cannot be read is left unbound for the next poll', async () => {
    const ghost = (await generateKeyPairSigner()).address;
    await insertCross(ghost, 'Live', T0 + 9n * H);
    expect(await bindCrosses(db, read, CROSS_CORE_PROGRAM_ADDRESS)).toEqual({ bound: 0, remaining: 1 });
    await db.query('DELETE FROM crosses WHERE address = $1', [ghost]);
  });

  describe('GET /v1/calendar', () => {
    it('is closed before the first session and names it as next', async () => {
      clock = Number(T0);
      const { status, body } = await get('/v1/calendar');
      expect(status).toBe(200);
      expect(body).toMatchObject({ network: 'devnet', asOf: String(T0), protocolPaused: false });
      const a = body.calendars.find((c: { address: string }) => c.address === calA);
      expect(a).toMatchObject({ state: 'closed', halted: false, current: null, next: { startTs: String(T0 + H), endTs: String(T0 + 7n * H) }, sessionCount: 2, verified: true, indexInSync: true });
      expect(a.schedule).toEqual([{ startTs: String(T0 + H), endTs: String(T0 + 7n * H) }, { startTs: String(T0 + 24n * H), endTs: String(T0 + 30n * H) }]);
      expect(a.crosses).toEqual([expect.objectContaining({ address: crossBound, state: 'Live', closeTs: String(T0 + H), session: { startTs: String(T0 + H), endTs: String(T0 + 7n * H) } })]);
    });

    it('is open during a session, listed before closed calendars, and closed again after it', async () => {
      clock = Number(T0 + 2n * H);
      let { body } = await get('/v1/calendar');
      expect(body.calendars[0]).toMatchObject({ address: calA, state: 'open', current: { startTs: String(T0 + H) }, next: { startTs: String(T0 + 24n * H) } });
      clock = Number(T0 + 7n * H);
      ({ body } = await get('/v1/calendar'));
      expect(body.calendars.find((c: { address: string }) => c.address === calA)).toMatchObject({ state: 'closed', previous: { startTs: String(T0 + H) } });
      clock = Number(T0 + 31n * H);
      ({ body } = await get('/v1/calendar'));
      const done = body.calendars.find((c: { address: string }) => c.address === calA);
      expect(done).toMatchObject({ state: 'closed', next: null, upcomingSessions: 0, schedule: [] });
      expect(body.calendars.at(-1).address).toBe(done.address);
    });

    it('reports a pending change with the time left, and halted while the protocol is paused', async () => {
      putCal(calA, { timelockSecs: 700_000n, pending: some({ sessions: [sess(T0 + 40n * H, T0 + 46n * H)], feeds: [], eta: T0 + 10n * H }), pendingAdmin: some({ admin: calB, eta: T0 + 8n * 24n * H }) });
      clock = Number(T0 + 2n * H);
      chain.set(await protocolAddress(), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getProtocolEncoder().encode({ admin: OTHER, guardian: OTHER, feeRecipient: OTHER, feeBps: [0, 0, 0, 0], paused: true, bump: 255, pendingAdmin: none() } as never)) });
      const { body } = await get('/v1/calendar');
      const a = body.calendars.find((c: { address: string }) => c.address === calA);
      expect(body.protocolPaused).toBe(true);
      expect(a).toMatchObject({ halted: true, state: 'open', pendingUpdate: { eta: String(T0 + 10n * H), appliesInSeconds: String(8n * H) }, pendingAdmin: { admin: calB } });
    });

    it('reads the chain, not the index: a changed account shows at once and indexInSync says the index is behind', async () => {
      putCal(calA, { timelockSecs: 700_000n, sessions: [sess(T0 + 3n * H, T0 + 4n * H)], pendingAdmin: some({ admin: calB, eta: T0 + 8n * 24n * H }) });
      clock = Number(T0 + 2n * H);
      const { body } = await get('/v1/calendar');
      expect(body.calendars.find((c: { address: string }) => c.address === calA)).toMatchObject({ state: 'closed', next: { startTs: String(T0 + 3n * H) }, indexInSync: false });
    });

    it('serves the indexed row, marked unverified, when the chain read finds no calendar', async () => {
      const saved = chain.get(calB)!;
      chain.delete(calB);
      const { body } = await get('/v1/calendar');
      expect(body.calendars.find((c: { address: string }) => c.address === calB)).toMatchObject({ verified: false, indexInSync: false });
      chain.set(calB, saved);
    });

    it('rejects a bad limit', async () => {
      expect((await get('/v1/calendar?limit=0')).status).toBe(400);
      expect((await get('/v1/calendar?limit=x')).status).toBe(400);
      expect((await get('/v1/calendar?limit=201')).status).toBe(400);
    });
  });

  it('the read cache shares one chain read of a calendar between requests inside its lifetime; a lifetime of 0 reads every time', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerCalendar } = await import('../src/routes/calendar.js');
    let calendarReads = 0;
    const deps = {
      db,
      network: 'devnet',
      account: async (a: Address) => {
        if (a === calA) calendarReads++;
        return chain.get(a) ?? null;
      },
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
    };
    for (const [ttl, expected] of [[60_000, 1], [0, 3]] as const) {
      const a = Fastify();
      registerCalendar(a, deps, { chainTtlMs: ttl });
      calendarReads = 0;
      for (let i = 0; i < 3; i++) expect((await a.inject({ method: 'GET', url: `/v1/calendar/${calA}` })).statusCode).toBe(200);
      expect(calendarReads).toBe(expected);
      await a.close();
    }
  });

  describe('GET /v1/calendar/:market', () => {
    it('returns every session, the events, and the bound crosses read from chain', async () => {
      putCal(calA, { timelockSecs: 604_800n });
      // The index still says Live; the chain says Cleared. The page must show what the chain holds.
      chain.set(crossBound, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(chain.get(crossBound)!.data), state: CrossState.Cleared, clearing: some({ price: 1_200_000n, matched: 400_000_000n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) } as never)) });
      clock = Number(T0 + 8n * H);
      const { status, body } = await get(`/v1/calendar/${calA}`);
      expect(status).toBe(200);
      expect(body.sessions).toHaveLength(2);
      expect(body.events.map((e: { name: string }) => e.name)).toEqual(['CalendarUpdated']);
      expect(body.crosses).toEqual([expect.objectContaining({ address: crossBound, state: 'Cleared', clearingPrice: '1200000', matched: '400000000' })]);
    });

    it('400 for a malformed address, 404 for an address that is not a calendar', async () => {
      expect((await get('/v1/calendar/not-an-address')).status).toBe(400);
      const stranger = (await generateKeyPairSigner()).address;
      expect((await get(`/v1/calendar/${stranger}`)).status).toBe(404);
      chain.set(stranger, { owner: OTHER as Address, data: calendarBytes() });
      expect((await get(`/v1/calendar/${stranger}`)).status).toBe(404);
    });

    it('serves a calendar on chain that the indexer has not seen yet, marked not in sync', async () => {
      const fresh = (await generateKeyPairSigner()).address;
      putCal(fresh, { id: 11n });
      const { status, body } = await get(`/v1/calendar/${fresh}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: '11', verified: true, indexInSync: null, events: [] });
    });
  });
});
