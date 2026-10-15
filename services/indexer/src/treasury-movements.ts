// The treasury movement read model (row F5, ADR-0930): every treasury event that moves value across the treasury's boundary, as one row, plus the functions an API route or an
// alert builder calls to read it.
//
// A movement is derived, never original: it comes from a treasury event and, for two events that do not carry it, from a row the indexer already holds (the destination of an
// executed spend proposal, the beneficiary of a grant). The live path (treasury.ts) writes the row in the same database transaction as the event; `backfillTreasuryMovements`
// replays the stored events through the same function for anything indexed before migration 020. One function, `movementOf`, decides what an event means, so the two paths
// cannot disagree.
//
// What this module does NOT do: decide who an "insider" or "team" wallet is. The program says which outflows are the team's (`guard_team_outflow` in programs/treasury/src/ext.rs
// covers an allowance spend, an executed spend proposal and a revenue tranche), and `teamOutflow` carries exactly that. Whether a counterparty is a known insider is a question for
// the layer that holds the insider list; it reads `counterparty` from here.
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export const MOVEMENT_KINDS = [
  'spend',
  'proposal_spend',
  'tranche_release',
  'grant_release',
  'sweep',
  'redemption',
  'nav_redemption',
  'distribution_deposit',
  'revenue_share',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** The treasury events that produce a movement. Every other treasury event moves no value across the boundary (a vote, a disclosure, a stake, a claim of an already deposited pot). */
export const MOVEMENT_EVENTS = ['Spent', 'ProposalExecuted', 'TrancheReleased', 'MilestoneReleased', 'UnclaimedSwept', 'Redeemed', 'NavRedeemed', 'DistributionDeposited', 'RoundPaid'] as const;

export interface MovementRow {
  kind: MovementKind;
  direction: 'out' | 'in';
  asset: 'quote' | 'coin';
  amount: string;
  counterparty: string | null;
  reference: string | null;
  teamOutflow: boolean;
  detail: Record<string, unknown>;
}

/** ProposalKind::Spend in programs/treasury (0 Spend, 1 OpenNav, 2 CloseNav). */
const PROPOSAL_SPEND = 0;

type Payload = Record<string, unknown>;
const text = (v: unknown): string => String(v);

/**
 * What one treasury event means as a movement, from its JSON payload (bigints already decimal strings, as stored in treasury_events). Null when the event moves nothing.
 * `lookup` answers the two questions an event cannot: where an executed spend proposal paid, and who a grant's beneficiary is.
 */
export async function movementOf(name: string, p: Payload, lookup: { proposalDestination(proposal: string): Promise<string | null>; grantBeneficiary(grant: string): Promise<string | null> }): Promise<MovementRow | null> {
  switch (name) {
    case 'Spent':
      return { kind: 'spend', direction: 'out', asset: 'quote', amount: text(p.amount), counterparty: text(p.to), reference: null, teamOutflow: true, detail: { spentInPeriod: text(p.spentInPeriod) } };
    case 'ProposalExecuted':
      // Opening or closing the NAV window moves nothing.
      if (Number(p.kind) !== PROPOSAL_SPEND) return null;
      return { kind: 'proposal_spend', direction: 'out', asset: 'quote', amount: text(p.amount), counterparty: await lookup.proposalDestination(text(p.proposal)), reference: text(p.proposal), teamOutflow: true, detail: {} };
    case 'TrancheReleased':
      // The event names no destination: the authority passes the account in the instruction. It is not guessed here.
      return { kind: 'tranche_release', direction: 'out', asset: 'quote', amount: text(p.amount), counterparty: null, reference: text(p.round), teamOutflow: true, detail: {} };
    case 'MilestoneReleased':
      // A grant pays the ownership coin itself, to the grant's beneficiary, and anyone may crank it.
      if (text(p.amount) === '0') return null;
      return { kind: 'grant_release', direction: 'out', asset: 'coin', amount: text(p.amount), counterparty: await lookup.grantBeneficiary(text(p.grant)), reference: text(p.grant), teamOutflow: false, detail: { milestone: Number(p.index) } };
    case 'UnclaimedSwept':
      return { kind: 'sweep', direction: 'out', asset: 'quote', amount: text(p.amount), counterparty: text(p.to), reference: null, teamOutflow: false, detail: {} };
    case 'Redeemed':
      return { kind: 'redemption', direction: 'out', asset: 'quote', amount: text(p.paid), counterparty: text(p.holder), reference: null, teamOutflow: false, detail: { coinBurned: text(p.burned) } };
    case 'NavRedeemed':
      return { kind: 'nav_redemption', direction: 'out', asset: 'quote', amount: text(p.paid), counterparty: text(p.holder), reference: null, teamOutflow: false, detail: { coinBurned: text(p.burned), periodBurned: text(p.periodBurned) } };
    case 'DistributionDeposited':
      return { kind: 'distribution_deposit', direction: 'in', asset: 'quote', amount: text(p.amount), counterparty: text(p.from), reference: null, teamOutflow: false, detail: { totalStaked: text(p.totalStaked) } };
    case 'RoundPaid':
      // The issuer's revenue share for a round goes into the stakers' pot: money in, from the payer.
      return { kind: 'revenue_share', direction: 'in', asset: 'quote', amount: text(p.due), counterparty: text(p.payer), reference: text(p.round), teamOutflow: false, detail: { revenue: text(p.revenue) } };
    default:
      return null;
  }
}

/** The lookups over the tables the indexer already keeps. */
export function tableLookups(db: Db) {
  return {
    async proposalDestination(proposal: string): Promise<string | null> {
      return ((await db.query('SELECT destination FROM treasury_proposals WHERE proposal = $1', [proposal])).rows[0]?.destination as string | undefined) ?? null;
    },
    async grantBeneficiary(grant: string): Promise<string | null> {
      return ((await db.query('SELECT beneficiary FROM treasury_grants WHERE grant_address = $1', [grant])).rows[0]?.beneficiary as string | undefined) ?? null;
    },
  };
}

/** Writes the movement of one event; false when the event moves nothing or the row already exists. */
export async function recordMovement(
  db: Db,
  ev: { signature: string; seq: number; slot: string; blockTime: string | null; treasury: string; name: string; payload: Payload },
): Promise<boolean> {
  if (ev.treasury === '') return false; // an event the index could not attribute to a treasury is in treasury_events, with a warning, and nowhere else
  const m = await movementOf(ev.name, ev.payload, tableLookups(db));
  if (!m) return false;
  const res = await db.query(
    `INSERT INTO treasury_movements (signature, seq, slot, block_time, treasury, kind, direction, asset, amount, counterparty, reference, team_outflow, detail)
     VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (signature, seq) DO NOTHING`,
    [ev.signature, ev.seq, ev.slot, ev.blockTime, ev.treasury, m.kind, m.direction, m.asset, m.amount, m.counterparty, m.reference, m.teamOutflow, JSON.stringify(m.detail)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Replays the stored treasury events that moved value and have no movement yet, oldest first. Idempotent; the indexer runs it after the migrations on every start, so a database
 * indexed before migration 020 gets its history without a re-index. Returns how many rows it wrote.
 */
export async function backfillTreasuryMovements(db: pg.Pool): Promise<number> {
  let written = 0;
  // Keyset pages over the stored events, so an event that moves nothing (a NAV window proposal) is passed once and never selected again.
  let after: { slot: string; signature: string; seq: number } = { slot: '0', signature: '', seq: -1 };
  for (;;) {
    const { rows } = await db.query(
      `SELECT e.signature, e.seq, e.slot::text AS slot, extract(epoch FROM e.block_time)::bigint::text AS block_time, e.treasury, e.name, e.payload
         FROM treasury_events e
        WHERE e.name = ANY($1) AND e.treasury <> '' AND (e.slot, e.signature, e.seq) > ($2::bigint, $3::text, $4::int)
          AND NOT EXISTS (SELECT 1 FROM treasury_movements m WHERE m.signature = e.signature AND m.seq = e.seq)
        ORDER BY e.slot, e.signature, e.seq
        LIMIT 500`,
      [MOVEMENT_EVENTS as unknown as string[], after.slot, after.signature, after.seq],
    );
    if (rows.length === 0) return written;
    for (const r of rows) {
      if (await recordMovement(db, { signature: r.signature, seq: r.seq, slot: r.slot, blockTime: r.block_time, treasury: r.treasury, name: r.name, payload: r.payload })) written++;
    }
    const last = rows.at(-1)!;
    after = { slot: last.slot, signature: last.signature, seq: last.seq };
  }
}

// ---------------------------------------------------------------- reads

export interface TreasuryMovement {
  id: string;
  signature: string;
  seq: number;
  slot: string;
  time: string | null;
  treasury: string;
  kind: MovementKind;
  direction: 'out' | 'in';
  asset: 'quote' | 'coin';
  amount: string;
  counterparty: string | null;
  reference: string | null;
  teamOutflow: boolean;
  detail: Record<string, unknown>;
}

const COLUMNS = `m.id::text AS id, signature, seq, slot::text AS slot, extract(epoch FROM block_time)::bigint::text AS time, treasury, kind, direction, asset, amount::text AS amount,
  counterparty, reference, team_outflow AS "teamOutflow", detail`;

export interface MovementFilter {
  treasury?: string;
  kinds?: readonly MovementKind[];
  direction?: 'out' | 'in';
  asset?: 'quote' | 'coin';
  /** Only the three outflows the program's guard covers. */
  teamOutflowOnly?: boolean;
  counterparty?: string;
  /** Movements at or above this many atoms of their asset (a decimal string). */
  minAmount?: string;
  /** Movements in this slot or later. */
  sinceSlot?: string;
}

function where(f: MovementFilter, params: unknown[]): string {
  const c: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    c.push(sql.replace('?', `$${params.length}`));
  };
  if (f.treasury) add('treasury = ?', f.treasury);
  if (f.kinds && f.kinds.length > 0) {
    for (const k of f.kinds) if (!(MOVEMENT_KINDS as readonly string[]).includes(k)) throw new RangeError(`unknown movement kind ${JSON.stringify(k)}; the kinds are ${MOVEMENT_KINDS.join(', ')}`);
    add('kind = ANY(?)', [...f.kinds]);
  }
  if (f.direction) add('direction = ?', f.direction);
  if (f.asset) add('asset = ?', f.asset);
  if (f.teamOutflowOnly) c.push('team_outflow');
  if (f.counterparty) add('counterparty = ?', f.counterparty);
  if (f.minAmount !== undefined) {
    if (!/^[0-9]{1,40}$/.test(f.minAmount)) throw new RangeError('minAmount must be a decimal integer string');
    add('amount >= ?::numeric', f.minAmount);
  }
  if (f.sinceSlot !== undefined) {
    if (!/^[0-9]{1,20}$/.test(f.sinceSlot)) throw new RangeError('sinceSlot must be a decimal integer string');
    add('slot >= ?::bigint', f.sinceSlot);
  }
  return c.length > 0 ? c.join(' AND ') : 'true';
}

const limitOf = (limit: number | undefined, max = 200): number => {
  const n = limit ?? 50;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`limit must be an integer from 1 to ${max}`);
  return n;
};

/**
 * Newest first. `before` is the `next` of the previous page (an id). Returns `next: null` on the last page. A route should pass user input straight in: bad input is a RangeError
 * (answer 400), and every value reaches the database as a parameter.
 */
export async function listTreasuryMovements(db: Db, filter: MovementFilter & { before?: string; limit?: number } = {}): Promise<{ movements: TreasuryMovement[]; next: string | null }> {
  const params: unknown[] = [];
  let cond = where(filter, params);
  if (filter.before !== undefined) {
    if (!/^[0-9]{1,18}$/.test(filter.before)) throw new RangeError('before must be a movement id');
    params.push(filter.before);
    cond += ` AND m.id < $${params.length}::bigint`;
  }
  const limit = limitOf(filter.limit);
  params.push(limit + 1);
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM treasury_movements m WHERE ${cond} ORDER BY m.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit) as TreasuryMovement[];
  return { movements: page, next: rows.length > limit ? page.at(-1)!.id : null };
}

/**
 * Oldest first, strictly after `afterId` ("0" for everything): what an alert builder polls. It remembers the last id it handled and asks for the ones after it. Ids follow the order the
 * indexer ingested the events, and one indexer process writes them one transaction at a time, so a later id never commits before an earlier one.
 */
export async function listMovementsAfter(db: Db, afterId: string, filter: MovementFilter & { limit?: number } = {}): Promise<TreasuryMovement[]> {
  if (!/^[0-9]{1,18}$/.test(afterId)) throw new RangeError('afterId must be a movement id');
  const params: unknown[] = [afterId];
  const cond = where(filter, params);
  params.push(limitOf(filter.limit, 1000));
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM treasury_movements m WHERE m.id > $1::bigint AND ${cond} ORDER BY m.id ASC LIMIT $${params.length}`, params);
  return rows as TreasuryMovement[];
}

export interface MovementTotal {
  kind: MovementKind;
  direction: 'out' | 'in';
  asset: 'quote' | 'coin';
  count: number;
  amount: string;
}

/** What a treasury has moved, summed by kind, direction and asset (the two assets are never added together). */
export async function treasuryMovementTotals(db: Db, treasury: string, sinceSlot?: string): Promise<MovementTotal[]> {
  const params: unknown[] = [];
  const cond = where({ treasury, ...(sinceSlot !== undefined && { sinceSlot }) }, params);
  const { rows } = await db.query(`SELECT kind, direction, asset, count(*)::int AS count, sum(amount)::text AS amount FROM treasury_movements WHERE ${cond} GROUP BY kind, direction, asset ORDER BY kind, direction, asset`, params);
  return rows as MovementTotal[];
}

/** The newest movement id, "0" when there is none: where a new alert subscriber starts so it does not replay history. */
export async function latestMovementId(db: Db): Promise<string> {
  return ((await db.query('SELECT coalesce(max(id), 0)::text AS id FROM treasury_movements')).rows[0]?.id as string | undefined) ?? '0';
}
