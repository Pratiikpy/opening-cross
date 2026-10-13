// GET /v1/calendar and GET /v1/calendar/:market (ROADMAP C6, ADR-0011).
//
// A "market" here is a cross_calendar account: a published list of UTC sessions, the Pyth feeds approved for crosses
// scheduled on it, and any change waiting out the timelock. The indexer's tables find the calendars and the crosses bound
// to them; every calendar returned is read from chain in the same request, so the sessions, the open/closed state and the
// pending change are never older than the call. What the program defines is a session being running or not, so `state` is
// `open` or `closed`. The calendar has no halt of its own: `halted` is true while cross_core's protocol-wide pause is on
// (it stops new crosses and new orders; reveals, clearing, claims and refunds are never paused).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder, getProtocolDecoder, protocolAddress } from '@opening-cross/sdk';
import { type CalendarRow, type Session, calendarFromAccount, canonicalJson, parseSessions, sessionStartingAt, sessionStatus } from '@opening-cross/indexer';
import type { ApiDeps } from '../server.js';
import { RequestError } from '../tx.js';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

const CROSS_STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
/** Crosses listed per calendar, newest close first. */
const CROSSES_PER_CALENDAR = 20;
/** Sessions returned in `schedule`. */
const SCHEDULE_LENGTH = 10;
/** Chain reads in flight at once. */
const READ_CONCURRENCY = 6;
const CALENDAR_COLUMNS = 'address, admin, calendar_id, timelock_secs, sessions, feeds, pending, pending_admin';

type IndexedCross = { address: string; state: string; close_ts: string; reveal_end_ts: string; clearing_price: string | null; matched: string | null };

const sessionOut = (s: Session) => ({ startTs: s.startTs, endTs: s.endTs });

function crossOut(c: IndexedCross, sessions: readonly Session[]) {
  const closeTs = BigInt(c.close_ts);
  const session = sessionStartingAt(sessions, closeTs);
  return {
    address: c.address,
    state: c.state,
    closeTs,
    revealEndTs: BigInt(c.reveal_end_ts),
    // The session this cross closes on. Null when the calendar was changed after the cross was created and no longer lists that start.
    session: session && sessionOut(session),
    clearingPrice: c.clearing_price,
    matched: c.matched,
  };
}

async function mapLimit<T, R>(items: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!);
    }),
  );
  return out;
}

/** pg returns BIGINT and NUMERIC columns as strings and JSONB as parsed values: only the id types need normalising. */
function normalise(r: Record<string, unknown>): CalendarRow {
  return { address: r.address, admin: r.admin, calendar_id: String(r.calendar_id), timelock_secs: String(r.timelock_secs), sessions: r.sessions, feeds: r.feeds, pending: r.pending ?? null, pending_admin: r.pending_admin ?? null } as CalendarRow;
}

const rank = (c: { state: string; next: unknown }) => (c.state === 'open' ? 0 : c.next ? 1 : 2);

/**
 * `chainTtlMs`: how long one calendar account read is reused (default 10 s), so a page that polls the list does not cost one RPC read
 * per calendar per request on a rate-limited endpoint. Simultaneous requests share a read either way. 0 reads on every request.
 */
export function registerCalendar(app: FastifyInstance, d: ApiDeps, opts: { chainTtlMs?: number; chainWaitMs?: number } = {}): void {
  const ttl = opts.chainTtlMs ?? 10_000;
  const reads = new Map<string, { at: number; value: Promise<Awaited<ReturnType<ApiDeps['account']>>> }>();
  const readAccount = (a: Address) => {
    const hit = reads.get(a);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = d.account(a);
    reads.set(a, { at: Date.now(), value });
    // A failed read is not kept: the next request tries again.
    value.catch(() => reads.get(a)?.value === value && reads.delete(a));
    return value;
  };
  const nowSec = () => BigInt(Math.floor(d.clock ? d.clock() : Date.now() / 1000));
  // A chain read that has not answered within this long (the shared endpoint rate-limits and the client retries with growing pauses) is
  // given up on: the page is served from the index, marked `verified: false`, instead of waiting out every retry.
  const chainWaitMs = opts.chainWaitMs ?? 3_000;
  // After one read gives up, further reads are skipped for BREAKER_MS and the index is served at once: a rate-limited endpoint is not
  // asked again by every request in the meantime, and the page does not wait three seconds on each.
  const BREAKER_MS = 15_000;
  let openUntil = 0;
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> => {
    if (Date.now() < openUntil) {
      p.catch(() => undefined);
      return Promise.resolve(fallback);
    }
    return Promise.race([
      p.catch(() => fallback),
      new Promise<T>((r) => setTimeout(() => { openUntil = Date.now() + BREAKER_MS; r(fallback); }, chainWaitMs).unref()),
    ]);
  };

  /** The protocol-wide pause flag, or null when the Protocol account cannot be read. */
  async function protocolPaused(): Promise<boolean | null> {
    const acct = await within(protocolAddress().then((a) => d.account(a)), null);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS) return null;
    try {
      return getProtocolDecoder().decode(acct.data).paused;
    } catch {
      return null;
    }
  }

  /** The calendar as the chain holds it now; the indexed row when the chain read finds nothing usable. */
  async function fromChain(address: string, indexed: CalendarRow | null): Promise<{ row: CalendarRow; verified: boolean; inSync: boolean | null } | null> {
    const acct = await within(readAccount(address as Address), null);
    const row = acct ? calendarFromAccount(address, acct) : null;
    if (row) return { row, verified: true, inSync: indexed ? canonicalJson(indexed) === canonicalJson(row) : null };
    return indexed ? { row: indexed, verified: false, inSync: false } : null;
  }

  function present(row: CalendarRow, now: bigint, paused: boolean | null, crosses: IndexedCross[], extra: { verified: boolean; inSync: boolean | null }) {
    const sessions = parseSessions(row.sessions);
    const status = sessionStatus(sessions, now);
    return {
      address: row.address,
      id: row.calendar_id,
      admin: row.admin,
      timelockSecs: row.timelock_secs,
      state: status.state,
      halted: paused === true,
      current: status.current && sessionOut(status.current),
      next: status.next && sessionOut(status.next),
      previous: status.previous && sessionOut(status.previous),
      sessionCount: sessions.length,
      upcomingSessions: sessions.filter((s) => s.endTs > now).length,
      // The sessions that have not ended, soonest first: enough for a page to keep counting down between refreshes.
      schedule: sessions.filter((s) => s.endTs > now).slice(0, SCHEDULE_LENGTH).map(sessionOut),
      feeds: row.feeds,
      pendingUpdate: row.pending && { sessions: parseSessions(row.pending.sessions).map(sessionOut), feeds: row.pending.feeds, eta: BigInt(row.pending.eta), appliesInSeconds: BigInt(row.pending.eta) - now },
      pendingAdmin: row.pending_admin && { admin: row.pending_admin.admin, eta: BigInt(row.pending_admin.eta) },
      crosses: crosses.map((c) => crossOut(c, sessions)),
      verified: extra.verified,
      indexInSync: extra.inSync,
    };
  }

  async function crossesOf(calendars: readonly string[]): Promise<Map<string, IndexedCross[]>> {
    const out = new Map<string, IndexedCross[]>(calendars.map((c) => [c, []]));
    if (calendars.length === 0) return out;
    const { rows } = await d.db.query(
      `SELECT b.calendar, c.address, c.state, c.close_ts, c.reveal_end_ts, c.clearing_price, c.matched
       FROM cross_calendar_binding b JOIN crosses c ON c.address = b.cross_address
       WHERE b.calendar = ANY($1) ORDER BY c.close_ts DESC`,
      [calendars],
    );
    for (const r of rows) {
      const list = out.get(r.calendar)!;
      if (list.length < CROSSES_PER_CALENDAR) list.push(r);
    }
    return out;
  }

  app.get('/v1/calendar', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    const now = nowSec();
    const { rows } = await d.db.query(`SELECT ${CALENDAR_COLUMNS} FROM calendars ORDER BY first_slot DESC LIMIT $1`, [limit]);
    const indexed = rows.map(normalise);
    const [paused, bound, read] = await Promise.all([
      protocolPaused(),
      crossesOf(indexed.map((r) => r.address)),
      mapLimit(indexed, READ_CONCURRENCY, (r) => fromChain(r.address, r)),
    ]);
    const calendars = read
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((x) => present(x.row, now, paused, bound.get(x.row.address) ?? [], x))
      // Open now first, then by the next session start; calendars with nothing left to run go last.
      .sort((a, b) => rank(a) - rank(b) || Number((a.next?.startTs ?? 0n) - (b.next?.startTs ?? 0n)));
    return send(reply, { network: d.network ?? 'unknown', asOf: now, protocolPaused: paused, calendars });
  });

  app.get('/v1/calendar/:market', async (req, reply) => {
    const market = (req.params as { market: string }).market;
    if (!isAddress(market)) throw new RequestError(400, 'market must be a base58 Solana address (a cross_calendar account)');
    const now = nowSec();
    const { rows } = await d.db.query(`SELECT ${CALENDAR_COLUMNS} FROM calendars WHERE address = $1`, [market]);
    const live = await fromChain(market, rows[0] ? normalise(rows[0]) : null);
    if (!live) throw new RequestError(404, `${market} is not a cross_calendar account`);
    const [paused, bound, events] = await Promise.all([
      protocolPaused(),
      crossesOf([market]),
      d.db.query(`SELECT signature, name, slot, extract(epoch FROM block_time)::bigint AS block_time, payload FROM calendar_events WHERE calendar_address = $1 ORDER BY slot DESC, seq DESC LIMIT 50`, [market]),
    ]);
    // A cross the index shows as unfinished is read from chain, so the page never shows a cleared cross as still collecting orders.
    const crosses = await mapLimit(bound.get(market) ?? [], READ_CONCURRENCY, async (c) => {
      if (c.state === 'Finalized') return c;
      const acct = await within(d.account(c.address as Address), null);
      if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) return c;
      const x = getCrossDecoder().decode(acct.data);
      const clearing = x.clearing.__option === 'Some' ? x.clearing.value : null;
      return { ...c, state: CROSS_STATE[x.state], clearing_price: clearing ? clearing.price.toString() : null, matched: clearing ? clearing.matched.toString() : null };
    });
    return send(reply, {
      network: d.network ?? 'unknown',
      asOf: now,
      protocolPaused: paused,
      ...present(live.row, now, paused, crosses, live),
      sessions: parseSessions(live.row.sessions).map(sessionOut),
      events: events.rows.map((e) => ({ name: e.name, signature: e.signature, slot: e.slot, blockTime: e.block_time, data: e.payload })),
    });
  });
}
