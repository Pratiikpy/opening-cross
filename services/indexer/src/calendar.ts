// cross_calendar in Postgres (ROADMAP C6, ADR-0011).
//
// The Calendar account holds the whole truth (sessions, approved feeds, a pending update and a pending admin handover),
// so the projection is never built by replaying events: an event, or any instruction aimed at a calendar, only says
// WHICH calendar to read again, and the row is overwritten with what the chain holds at the finalized slot. Replay,
// re-ingest and a missed event are therefore harmless, and `reconcileCalendars` repairs whatever slipped past.
//
// Two facts about the program shape this:
//   - propose_admin emits no event, so a transaction can change a calendar without any log line. Calendars are
//     therefore found from the accounts of the instructions aimed at the program, not only from events.
//   - CrossCreated does not carry the cross's calendar. It is read from the Cross account (`bindCrosses`).
import { type Address, address as toAddress, getBase58Decoder, type Base58EncodedBytes, type Signature } from '@solana/kit';
import type pg from 'pg';
import {
  CALENDAR_ADMIN_CHANGED_EVENT_DISCRIMINATOR,
  CALENDAR_DISCRIMINATOR,
  CALENDAR_UPDATED_EVENT_DISCRIMINATOR,
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  UPDATE_CANCELLED_EVENT_DISCRIMINATOR,
  UPDATE_PROPOSED_EVENT_DISCRIMINATOR,
  type Calendar,
  getCalendarAdminChangedEventDecoder,
  getCalendarDecoder,
  getCalendarUpdatedEventDecoder,
  getUpdateCancelledEventDecoder,
  getUpdateProposedEventDecoder,
} from '@opening-cross/cross-calendar-client';
import { getCrossDecoder } from '@opening-cross/cross-core-client';
import { toJson } from './decode.js';
import type { TxBody } from './order-terms.js';
import type { IndexerRpc } from './rpc.js';

// ------------------------------------------------------------------------------------------------ sessions (pure)

export type Session = { startTs: bigint; endTs: bigint };
export type MarketStatus = {
  /** `open` while a session is running at `now`, else `closed`. The program defines nothing else for a calendar. */
  state: 'open' | 'closed';
  /** The running session. */
  current: Session | null;
  /** The first session that starts after `now`. */
  next: Session | null;
  /** The last session that ended at or before `now`. */
  previous: Session | null;
};

/** Where a calendar's sessions stand at `now` (unix seconds). Sessions are increasing and never overlap (the program's `validate`). */
export function sessionStatus(sessions: readonly Session[], now: bigint): MarketStatus {
  let current: Session | null = null;
  let next: Session | null = null;
  let previous: Session | null = null;
  for (const s of sessions) {
    if (s.startTs <= now && now < s.endTs) current = s;
    else if (s.startTs > now) next ??= s;
    else previous = s;
  }
  return { state: current ? 'open' : 'closed', current, next, previous };
}

/** The session of `sessions` that starts exactly at `ts`: the one a calendar-bound cross closes on. */
export const sessionStartingAt = (sessions: readonly Session[], ts: bigint): Session | null => sessions.find((s) => s.startTs === ts) ?? null;

export const parseSessions = (json: unknown): Session[] =>
  (json as { startTs: string; endTs: string }[]).map((s) => ({ startTs: BigInt(s.startTs), endTs: BigInt(s.endTs) }));

// ------------------------------------------------------------------------------------------------ events

export type CalendarEvent =
  | { name: 'CalendarUpdated'; calendar: Address; data: ReturnType<ReturnType<typeof getCalendarUpdatedEventDecoder>['decode']> }
  | { name: 'UpdateProposed'; calendar: Address; data: ReturnType<ReturnType<typeof getUpdateProposedEventDecoder>['decode']> }
  | { name: 'UpdateCancelled'; calendar: Address; data: ReturnType<ReturnType<typeof getUpdateCancelledEventDecoder>['decode']> }
  | { name: 'CalendarAdminChanged'; calendar: Address; data: ReturnType<ReturnType<typeof getCalendarAdminChangedEventDecoder>['decode']> };

const DECODERS: [Uint8Array, CalendarEvent['name'], { decode(b: Uint8Array): { calendar: Address } }][] = [
  [CALENDAR_UPDATED_EVENT_DISCRIMINATOR as Uint8Array, 'CalendarUpdated', getCalendarUpdatedEventDecoder()],
  [UPDATE_PROPOSED_EVENT_DISCRIMINATOR as Uint8Array, 'UpdateProposed', getUpdateProposedEventDecoder()],
  [UPDATE_CANCELLED_EVENT_DISCRIMINATOR as Uint8Array, 'UpdateCancelled', getUpdateCancelledEventDecoder()],
  [CALENDAR_ADMIN_CHANGED_EVENT_DISCRIMINATOR as Uint8Array, 'CalendarAdminChanged', getCalendarAdminChangedEventDecoder()],
];

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** Thrown when a log stream cannot be attributed safely (truncated, or exits that do not match invokes). */
export class UnattributableCalendarLogs extends Error {}

/**
 * Events written while cross_calendar is on top of the invoke stack. The attribution is by program, not by discriminator,
 * because an event emitted by another program must never be read as ours. Events from before the ADR-0027 upgrade
 * (`AdminChanged`, discriminator e8221fe23e121372) are not recognized: the account read covers the state they described.
 */
export function decodeCalendarLogs(logs: readonly string[], program: Address = CROSS_CALENDAR_PROGRAM_ADDRESS): CalendarEvent[] {
  const stack: string[] = [];
  const out: CalendarEvent[] = [];
  for (const line of logs) {
    if (line === 'Log truncated') throw new UnattributableCalendarLogs('log output was truncated by the runtime');
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const ex = EXIT.exec(line);
    if (ex) {
      if (stack.at(-1) !== ex[1]) throw new UnattributableCalendarLogs(`unbalanced exit for ${ex[1]}`);
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack.at(-1) !== program) continue;
    const bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64'));
    const match = DECODERS.find(([d]) => bytes.length >= 8 && d.every((b, i) => bytes[i] === b));
    if (!match) continue;
    const data = match[2].decode(bytes);
    out.push({ name: match[1], calendar: data.calendar, data } as CalendarEvent);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the row

export type CalendarRow = {
  address: string;
  admin: string;
  calendar_id: string;
  timelock_secs: string;
  sessions: { startTs: string; endTs: string }[];
  feeds: string[];
  pending: { sessions: { startTs: string; endTs: string }[]; feeds: string[]; eta: string } | null;
  pending_admin: { admin: string; eta: string } | null;
};

const hex = (b: ArrayLike<number>) => Buffer.from(Array.from(b)).toString('hex');
const sessionJson = (s: Session) => ({ startTs: s.startTs.toString(), endTs: s.endTs.toString() });

/** Decodes a Calendar account, or null if it is not one (wrong owner, wrong discriminator, or bytes the layout cannot read). */
export function calendarFromAccount(address: string, account: { data: Uint8Array; owner: string }): CalendarRow | null {
  const { data } = account;
  if (account.owner !== CROSS_CALENDAR_PROGRAM_ADDRESS || data.length < 8 || !(CALENDAR_DISCRIMINATOR as Uint8Array).every((b, i) => data[i] === b)) return null;
  let c: Calendar;
  try {
    c = getCalendarDecoder().decode(data);
  } catch {
    return null;
  }
  return {
    address,
    admin: c.admin,
    calendar_id: c.id.toString(),
    timelock_secs: c.timelockSecs.toString(),
    sessions: c.sessions.map(sessionJson),
    feeds: c.feeds.map(hex),
    pending: c.pending.__option === 'Some' ? { sessions: c.pending.value.sessions.map(sessionJson), feeds: c.pending.value.feeds.map(hex), eta: c.pending.value.eta.toString() } : null,
    pending_admin: c.pendingAdmin.__option === 'Some' ? { admin: c.pendingAdmin.value.admin, eta: c.pendingAdmin.value.eta.toString() } : null,
  };
}

/**
 * The sessions of a Calendar account whose owner the caller has not seen (a bare account fetch). Only for naming a session in a
 * log line or a page: anything that acts on a calendar must go through `calendarFromAccount`, which checks the owner.
 */
export function calendarSessions(data: Uint8Array): Session[] | null {
  if (data.length < 8 || !(CALENDAR_DISCRIMINATOR as Uint8Array).every((b, i) => data[i] === b)) return null;
  try {
    return getCalendarDecoder().decode(data).sessions.map((s) => ({ startTs: s.startTs, endTs: s.endTs }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ chain reads

export type ChainRead = { data: Uint8Array; owner: string };
/** Reads accounts at one finalized slot. A missing account maps to null. */
export type ReadAccounts = (addresses: readonly string[]) => Promise<{ slot: bigint; accounts: Map<string, ChainRead | null> }>;

export function rpcAccountReader(rpc: IndexerRpc): ReadAccounts {
  return async (addresses) => {
    const accounts = new Map<string, ChainRead | null>();
    let slot = 0n;
    // getMultipleAccounts takes at most 100 addresses.
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const res = await rpc.getMultipleAccounts(chunk.map((a) => toAddress(a)), { commitment: 'finalized', encoding: 'base64' }).send();
      slot = res.context.slot;
      chunk.forEach((a, j) => {
        const v = res.value[j];
        accounts.set(a, v ? { data: Uint8Array.from(Buffer.from(v.data[0], 'base64')), owner: v.owner } : null);
      });
    }
    return { slot, accounts };
  };
}

/** Every Calendar account of the program, from a discriminator-filtered scan. */
export async function scanCalendars(rpc: IndexerRpc, program: Address = CROSS_CALENDAR_PROGRAM_ADDRESS): Promise<{ slot: bigint; calendars: CalendarRow[] }> {
  const res = await rpc
    .getProgramAccounts(program, {
      commitment: 'finalized',
      encoding: 'base64',
      withContext: true,
      filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(CALENDAR_DISCRIMINATOR as Uint8Array) as Base58EncodedBytes, encoding: 'base58' } }],
    })
    .send();
  const calendars: CalendarRow[] = [];
  for (const a of res.value) {
    const row = calendarFromAccount(a.pubkey, { data: Uint8Array.from(Buffer.from(a.account.data[0], 'base64')), owner: a.account.owner });
    if (row) calendars.push(row);
  }
  return { slot: res.context.slot, calendars };
}

// ------------------------------------------------------------------------------------------------ ingest

export type CalendarTx = {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  logs: readonly string[];
  err: unknown;
  /** Accounts passed to instructions aimed at cross_calendar: the calendar this transaction changed is one of them. */
  candidates: readonly string[];
};

/** The accounts of every top-level instruction aimed at `program`, from a `getTransaction` (json encoding) result. */
export function calendarCandidates(tx: TxBody, program: string = CROSS_CALENDAR_PROGRAM_ADDRESS): string[] {
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const out = new Set<string>();
  for (const ix of tx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== program) continue;
    for (const i of ix.accounts) out.add(keys[i]!);
  }
  return [...out];
}

const UPSERT = `INSERT INTO calendars (address, admin, calendar_id, timelock_secs, sessions, feeds, pending, pending_admin, first_slot, read_slot)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT (address) DO UPDATE SET admin = EXCLUDED.admin, calendar_id = EXCLUDED.calendar_id, timelock_secs = EXCLUDED.timelock_secs,
    sessions = EXCLUDED.sessions, feeds = EXCLUDED.feeds, pending = EXCLUDED.pending, pending_admin = EXCLUDED.pending_admin,
    first_slot = LEAST(calendars.first_slot, EXCLUDED.first_slot), read_slot = EXCLUDED.read_slot, updated_at = now()`;

async function upsert(db: pg.PoolClient | pg.Pool, row: CalendarRow, slot: bigint, firstSlot: bigint = slot): Promise<void> {
  // first_slot is the transaction's slot when it is known; read_slot is the slot the account was read at.
  await db.query(UPSERT, [
    row.address, row.admin, row.calendar_id, row.timelock_secs, JSON.stringify(row.sessions), JSON.stringify(row.feeds),
    row.pending ? JSON.stringify(row.pending) : null, row.pending_admin ? JSON.stringify(row.pending_admin) : null, firstSlot.toString(), slot.toString(),
  ]);
}

/**
 * Applies one cross_calendar transaction. The events are appended (a signature already stored changes nothing), then
 * every calendar the transaction touched is read from chain and overwritten. Returns how many events were new.
 * A failed transaction changes no state, whatever it logged.
 */
export async function ingestCalendarTransaction(db: pg.Pool, tx: CalendarTx, read: ReadAccounts): Promise<number> {
  if (tx.err) return 0;
  const events = decodeCalendarLogs(tx.logs);
  const candidates = [...new Set([...tx.candidates, ...events.map((e) => e.calendar)])];
  if (candidates.length === 0) return 0;
  const { slot: readSlot, accounts } = await read(candidates);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const res = await client.query(
        `INSERT INTO calendar_events (signature, seq, slot, block_time, name, calendar_address, payload) VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.name, ev.calendar, JSON.stringify(toJson(ev.data))],
      );
      applied += res.rowCount ?? 0;
    }
    for (const a of candidates) {
      const acct = accounts.get(a);
      const row = acct ? calendarFromAccount(a, acct) : null;
      // An instruction's other accounts (the admin, the system program) are not calendars: only decoded calendars are stored.
      if (row) await upsert(client, row, readSlot, tx.slot);
    }
    await client.query('COMMIT');
    return applied;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------ poll

const RETRY_PAGE = 1000;

/**
 * Walks cross_calendar's finalized signatures newest-to-oldest back to the stored cursor, then ingests oldest-first; the
 * cursor advances only after each transaction commits. Same contract as the cross_core poll (rpc-source.ts).
 */
export async function pollCalendar(db: pg.Pool, rpc: IndexerRpc, read: ReadAccounts = rpcAccountReader(rpc), program: Address = CROSS_CALENDAR_PROGRAM_ADDRESS): Promise<number> {
  const source = `rpc:${program}`;
  const { rows } = await db.query('SELECT last_signature FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const pending: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', limit: RETRY_PAGE, ...(until && { until }), ...(before && { before }) }).send();
    for (const s of page) pending.push({ signature: s.signature, slot: s.slot });
    if (page.length < RETRY_PAGE) break;
    before = page.at(-1)!.signature;
  }
  pending.reverse();
  let applied = 0;
  for (const s of pending) {
    const tx = await rpc.getTransaction(s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (!tx) throw new Error(`getTransaction(${s.signature}) returned nothing at finalized`);
    applied += await ingestCalendarTransaction(
      db,
      { signature: s.signature, slot: tx.slot, blockTime: tx.blockTime === null ? null : BigInt(tx.blockTime), logs: tx.meta?.logMessages ?? [], err: tx.meta?.err ?? null, candidates: calendarCandidates(tx as unknown as TxBody, program) },
      read,
    );
    await db.query(
      `INSERT INTO cursors (source, last_signature, last_slot) VALUES ($1,$2,$3) ON CONFLICT (source) DO UPDATE SET last_signature = EXCLUDED.last_signature, last_slot = EXCLUDED.last_slot`,
      [source, s.signature, s.slot.toString()],
    );
  }
  return applied;
}

// ------------------------------------------------------------------------------------------------ crosses

/**
 * Records which calendar each indexed cross is bound to, from the Cross account (the binding is fixed at creation, so a
 * cross is read once). At most `limit` crosses per call, so a large backlog is worked off over several polls.
 * A cross whose account cannot be read stays unbound in the table and is tried again next time.
 */
export async function bindCrosses(db: pg.Pool, read: ReadAccounts, crossProgram: string, limit = 50): Promise<{ bound: number; remaining: number }> {
  const { rows } = await db.query(
    `SELECT c.address FROM crosses c LEFT JOIN cross_calendar_binding b ON b.cross_address = c.address WHERE b.cross_address IS NULL ORDER BY c.created_slot LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return { bound: 0, remaining: 0 };
  const { slot, accounts } = await read(rows.map((r) => r.address as string));
  let bound = 0;
  for (const r of rows) {
    const acct = accounts.get(r.address);
    if (!acct || acct.owner !== crossProgram) continue;
    let calendar: string | null = null;
    try {
      const c = getCrossDecoder().decode(acct.data);
      calendar = c.calendar.__option === 'Some' ? c.calendar.value : null;
    } catch {
      continue;
    }
    await db.query('INSERT INTO cross_calendar_binding (cross_address, calendar, read_slot) VALUES ($1,$2,$3) ON CONFLICT (cross_address) DO NOTHING', [r.address, calendar, slot.toString()]);
    bound++;
  }
  const left = await db.query('SELECT count(*)::int AS n FROM crosses c LEFT JOIN cross_calendar_binding b ON b.cross_address = c.address WHERE b.cross_address IS NULL');
  return { bound, remaining: left.rows[0].n };
}

// ------------------------------------------------------------------------------------------------ reconcile

export type CalendarDrift = { calendar: string; field: string; indexed: string | null; onchain: string | null };

/** JSON with object keys sorted: Postgres JSONB hands keys back in its own order, so two equal values can stringify differently. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const FIELDS = ['admin', 'calendar_id', 'timelock_secs', 'sessions', 'feeds', 'pending', 'pending_admin'] as const;
const show = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

async function diff(db: pg.Pool, calendars: readonly CalendarRow[]): Promise<CalendarDrift[]> {
  const { rows } = await db.query('SELECT address, admin, calendar_id, timelock_secs, sessions, feeds, pending, pending_admin FROM calendars');
  const indexed = new Map<string, Record<string, unknown>>(rows.map((r) => [r.address as string, r]));
  const drift: CalendarDrift[] = [];
  for (const c of calendars) {
    const row = indexed.get(c.address);
    if (!row) {
      drift.push({ calendar: c.address, field: 'exists', indexed: null, onchain: 'true' });
      continue;
    }
    for (const f of FIELDS) {
      const a = f === 'calendar_id' || f === 'timelock_secs' ? String(row[f]) : row[f];
      if (canonicalJson(a) !== canonicalJson(c[f])) drift.push({ calendar: c.address, field: f, indexed: show(row[f]), onchain: show(c[f]) });
    }
  }
  const onchain = new Set(calendars.map((c) => c.address));
  for (const address of indexed.keys()) if (!onchain.has(address)) drift.push({ calendar: address, field: 'exists', indexed: 'true', onchain: null });
  return drift;
}

/**
 * Compares the `calendars` table with every Calendar account on chain and returns what still disagrees after the indexer
 * has had a chance to catch up: the scan is finalized, so a transaction that finalized a moment ago may not be ingested
 * yet. `catchUp` is run (and the comparison repeated) up to `attempts` times; only lasting disagreement is drift.
 * The chain is the source of truth: with `repair` the differing rows are overwritten from it, and with `record` the
 * disagreements are stored in `calendar_reconciliation_alerts`. A calendar in the table that is gone from chain is
 * reported, never deleted.
 */
export async function reconcileCalendars(
  db: pg.Pool,
  scan: () => Promise<{ slot: bigint; calendars: CalendarRow[] }>,
  opts: { catchUp?: () => Promise<unknown>; attempts?: number; waitMs?: number; record?: boolean; repair?: boolean } = {},
): Promise<CalendarDrift[]> {
  let { slot, calendars } = await scan();
  let drift = await diff(db, calendars);
  for (let i = 0; drift.length > 0 && opts.catchUp && i < (opts.attempts ?? 3); i++) {
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 10_000));
    await opts.catchUp();
    ({ slot, calendars } = await scan());
    drift = await diff(db, calendars);
  }
  if (opts.record) for (const d of drift) await db.query('INSERT INTO calendar_reconciliation_alerts (calendar, field, indexed, onchain) VALUES ($1,$2,$3,$4)', [d.calendar, d.field, d.indexed, d.onchain]);
  if (opts.repair) {
    const bad = new Set(drift.map((d) => d.calendar));
    for (const c of calendars) if (bad.has(c.address)) await upsert(db, c, slot);
  }
  return drift;
}
