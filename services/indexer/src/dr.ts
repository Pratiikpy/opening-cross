// Disaster recovery for the database (PRODUCT_FEATURES R15). Two questions, answered by code and not by a document:
//
//   1. Which tables can be rebuilt from the chain, and which hold something nobody else has? TABLE_CLASS says, and a test fails when a
//      table exists in any migration or service that is not classified, so a new table cannot silently fall outside the backup.
//   2. Does a backup restore to exactly what was backed up? `logicalBackup` writes each table as one JSON line per row with a manifest of
//      row counts and sha-256 digests; `logicalRestore` loads it into an empty database and `tableDigests` proves the two are equal.
//
// The backup is logical (SQL-level) so it needs nothing beyond the database connection the services already have. A production host
// should ALSO take physical backups with pg_dump or the provider's snapshots; this is the part that can be checked anywhere.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

export type TableKind = 'chain' | 'derived' | 'cache' | 'backup';
export interface TableClass {
  kind: TableKind;
  /** chain: how it is rebuilt. derived: what it is computed from. cache: why dropping it is safe. backup: what is lost without a backup. */
  note: string;
}

export const TABLE_CLASS: Readonly<Record<string, TableClass>> = {
  // Rebuilt by running the indexer again from the first signature of each program.
  events: { kind: 'chain', note: 'every cross_core event, decoded from transactions; re-run the indexer' },
  crosses: { kind: 'chain', note: 'cross state, rebuilt from events and the cross accounts' },
  orders: { kind: 'chain', note: 'order state, rebuilt from events and the order accounts' },
  cursors: { kind: 'chain', note: 'where each source was read to; absent means "from the beginning"' },
  indexer_heartbeat: { kind: 'chain', note: 'liveness of the indexer; rewritten on the next poll' },
  reconciliation_alerts: { kind: 'chain', note: 'drift found between the database and the chain; found again by the next reconciliation' },
  cross_statics: { kind: 'chain', note: 'immutable fields of each cross, read from its account' },
  calendars: { kind: 'chain', note: 'cross_calendar accounts, re-read by the calendar indexer' },
  calendar_events: { kind: 'chain', note: 'cross_calendar events, re-read by the calendar indexer' },
  cross_calendar_binding: { kind: 'chain', note: 'which calendar a cross is bound to, read from the cross account' },
  calendar_reconciliation_alerts: { kind: 'chain', note: 'drift between the calendar tables and the chain' },
  treasuries: { kind: 'chain', note: 'treasury accounts, re-read by the treasury indexer' },
  treasury_events: { kind: 'chain', note: 'treasury events, re-read by the treasury indexer' },
  // The extensions (migrations 016 to 018): all of it is projected from events, so re-running the indexer from the first signature rebuilds it.
  cross_rules: { kind: 'chain', note: 'the rules each cross was created with and its draw state, projected from RulesSet, DrawStarted, DrawFinished and ExtensionPending' },
  order_placements: { kind: 'chain', note: 'where the chain clock placed each order (ending bucket, epoch, class, lockup), from OrderPlacement' },
  cross_challenges: { kind: 'chain', note: 'insider challenges and their outcome, from InsiderChallenged, ChallengeResolved and ChallengeExpired' },
  cross_locks: { kind: 'chain', note: 'locked fills, from LockCreated and LockReleased; the exact released amount is the lockup account' },
  halt_states: { kind: 'chain', note: 'halt state changes per base mint, from HaltChanged' },
  print_feed_prints: { kind: 'chain', note: 'prints that fed the lender feed, from PrintFed' },
  series: { kind: 'chain', note: 'recurring series, from SeriesCreated' },
  series_crosses: { kind: 'chain', note: 'the crosses a series spawned, from SeriesSpawned' },
  settle_events: { kind: 'chain', note: 'every cross_settle event, re-read by the settlement indexer' },
  settle_greenshoes: { kind: 'chain', note: 'greenshoes and their levels, from GreenshoeCreated, GreenshoeBidPlaced, GreenshoeLevelSettled and GreenshoeFinished' },
  settle_partner: { kind: 'chain', note: 'partner payouts summed per cross, from the Partner and PolFees events' },
  settle_venues: { kind: 'chain', note: 'the venue each cross opened, from the pool-opening events' },
  treasury_proposals: { kind: 'chain', note: 'holder proposals, from ProposalCreated, Voted and ProposalExecuted' },
  treasury_votes: { kind: 'chain', note: 'coins locked behind proposals, from Voted and VoteReclaimed' },
  treasury_stakers: { kind: 'chain', note: 'what each owner has staked and claimed, from Staked, Unstaked and DistributionClaimed' },
  treasury_grants: { kind: 'chain', note: 'team grants, from GrantCreated, MilestoneReleased and GrantExpired' },
  treasury_rounds: { kind: 'chain', note: 'revenue rounds paid or missed, from RoundPaid, RoundMissed and TrancheReleased' },
  // The seven Wave 3D programs (migration 019): all of it is projected from their events, so re-running the indexer from each program's first signature rebuilds it.
  program_events: { kind: 'chain', note: 'every event of the seven Wave 3D programs, decoded from transactions; re-run the indexer' },
  mandates: { kind: 'chain', note: 'auto-invest mandates, from MandateCreated, MandateFunded, LimitsChanged, MandateRevoked, MandateWithdrawn and MandateOrderPlaced' },
  mandate_orders: { kind: 'chain', note: 'the orders each mandate placed, from MandateOrderPlaced' },
  conviction_locks: { kind: 'chain', note: 'conviction locks, from Locked, Unlocked and BadgeClaimed' },
  conviction_badges: { kind: 'chain', note: 'the badge mint of each holder and token, from BadgeCreated' },
  baskets: { kind: 'chain', note: 'basket tokens and the shares minted and redeemed, from BasketCreated, SharesMinted and SharesRedeemed' },
  listing_venues: { kind: 'chain', note: 'listing venues, from VenueCreated' },
  listing_bonds: { kind: 'chain', note: 'the bond of each lister, from BondDeposited, BondWithdrawn and Listed' },
  listing_listings: { kind: 'chain', note: 'listings and how each ended, from Listed, ListingReleased and ListingSlashed' },
  bounties: { kind: 'chain', note: 'adversarial bounties, from BountyCreated, BountyFunded, InvariantPaid, Awarded and BountyWithdrawn' },
  bounty_payouts: { kind: 'chain', note: 'what each bounty paid and to whom, from InvariantPaid and Awarded' },
  backing_policies: { kind: 'chain', note: 'opted-in backing policies, from PolicyCreated' },
  backing_attestations: { kind: 'chain', note: 'the latest backing statement per asset, from Attested' },
  backing_failures: { kind: 'chain', note: 'every check that found the backing missing, stale or short, from BackingFailed' },
  graduation_charters: { kind: 'chain', note: 'graduation charters, from CharterCreated' },
  graduation_rounds: { kind: 'chain', note: 'graduation rounds and their tallies, from RoundStarted, VoteCast, VolumePosted and RoundFinalized' },
  graduation_votes: { kind: 'chain', note: 'tokens locked behind a venue, from VoteCast and VoteWithdrawn' },
  graduation_outcomes: { kind: 'chain', note: 'the published outcome of a passed vote, from OutcomePublished' },
  // Computed from other tables.
  promise_grades: { kind: 'derived', note: 'each promise scored against the realised clearing price: recomputed from promises and crosses' },
  preset_uses: { kind: 'derived', note: 'which crosses used which preset, read from the memo in each creation transaction: read again from the chain' },
  // Safe to drop: read again on demand.
  token_labels: { kind: 'cache', note: 'name and symbol of a mint, read from its metadata on demand' },
  funding_cache: { kind: 'cache', note: 'first funder of a wallet, traced again from its transaction history on demand' },
  // Held nowhere else: lose the database without a backup and these are gone.
  promises: { kind: 'backup', note: 'signed clearing-price promises; the signed document exists only here (the chain holds the outcome, not the promise)' },
  promise_anchors: { kind: 'backup', note: 'anchored promise batches' },
  promise_anchor_members: { kind: 'backup', note: 'which promises each anchor commits to' },
  premium_observations: { kind: 'backup', note: 'time-stamped observations of the premium to a reference price; a past observation cannot be taken again' },
  referrals: { kind: 'backup', note: 'referral documents signed by the referred wallets' },
  liquidity_makers: { kind: 'backup', note: 'signed market-maker registrations' },
  liquidity_quotes: { kind: 'backup', note: 'signed quotes; short-lived, but the record of what was quoted is not on chain' },
  intents: { kind: 'backup', note: 'signed order intents' },
  integrity_documents: { kind: 'backup', note: 'supply declarations, team lists and backing attestations signed by third parties' },
  rating_snapshots: { kind: 'backup', note: 'each rating as it was computed; recomputing later can give a different answer' },
  rating_outcomes: { kind: 'backup', note: 'what happened after a rating, with its source' },
  billing_payments: { kind: 'backup', note: 'subscription payments read from chain; re-readable from the revenue wallet\'s history, but nothing does that automatically' },
  billing_invoices: { kind: 'backup', note: 'signed invoices as issued' },
  treasury_updates: { kind: 'backup', note: 'signed treasury updates published off chain' },
  presets: { kind: 'backup', note: 'signed presets published by their authors; the signed document is only here' },
  ops_log: { kind: 'backup', note: 'the hash-chained audit log of the operations console; it exists nowhere else, and a copy kept elsewhere is what makes a rewrite visible' },
  ops_listings: { kind: 'backup', note: 'listing reviews with the evidence gathered and the decision recorded' },
  ops_incidents: { kind: 'backup', note: 'incidents and how they were resolved' },
  ops_cases: { kind: 'backup', note: 'compliance cases (personal data may be involved)' },
  ops_case_notes: { kind: 'backup', note: 'append-only notes on cases' },
  x402_payments: { kind: 'backup', note: 'settled pay-per-call payments and what each bought; the settlement is on chain, the link from payment to delivery is only here' },
  x402_attempts: { kind: 'backup', note: 'payment attempts and their delivery state, which make a retried payment deliver once' },
  x402_migrations: { kind: 'backup', note: 'which x402 migrations have run; restoring the data without it would run them again over existing tables' },
  gate_allowlists: { kind: 'backup', note: 'the addresses behind a published allowlist root; the root is on chain, the list (needed to build proofs) is not' },
  issuer_records: { kind: 'backup', note: 'issuer-entered records' },
  cross_comments: { kind: 'backup', note: 'comments on crosses' },
  sponsor_ledger: { kind: 'backup', note: 'accounting of sponsored transactions' },
  alert_subscriptions: { kind: 'backup', note: 'holder alert subscriptions (personal data: contacts a holder gave)' },
  alert_deliveries: { kind: 'backup', note: 'log of alerts sent' },
  alert_telegram_codes: { kind: 'backup', note: 'pending Telegram link codes' },
  alert_telegram_cursor: { kind: 'backup', note: 'where the Telegram updates were read to' },
  support_requests: { kind: 'backup', note: 'requests holders sent to support (personal data)' },
};

/** Tables a backup must contain. */
export const backupTables = (): string[] => Object.entries(TABLE_CLASS).filter(([, c]) => c.kind === 'backup').map(([t]) => t);

/** Tables found in the repository that nobody classified. Empty when the table is known. */
export function unclassified(found: readonly string[]): string[] {
  return found.filter((t) => !(t in TABLE_CLASS)).sort();
}

const q = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe table name ${JSON.stringify(name)}`);
  return `"${name}"`;
};

export async function existingTables(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name");
  return rows.map((r) => r.table_name);
}

/** One JSON object per row, as the database itself serialises it (so numeric and bigint keep every digit), in a fixed order. */
async function rowLines(db: pg.Pool, table: string): Promise<string[]> {
  const { rows } = await db.query<{ j: string }>(`SELECT j FROM (SELECT row_to_json(t)::text AS j FROM ${q(table)} t) s ORDER BY j COLLATE "C"`);
  return rows.map((r) => r.j);
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A digest per table: sha-256 of its rows in a fixed order. Two databases with equal digests hold equal rows. */
export async function tableDigests(db: pg.Pool, tables?: readonly string[]): Promise<Record<string, { rows: number; sha256: string }>> {
  const names = tables ?? (await existingTables(db)).filter((t) => t in TABLE_CLASS);
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const t of names) {
    const lines = await rowLines(db, t);
    out[t] = { rows: lines.length, sha256: sha(lines.join('\n')) };
  }
  return out;
}

export interface Manifest {
  schema: 'opening-cross/backup/v1';
  createdAt: string;
  kinds: TableKind[];
  tables: { name: string; kind: TableKind; rows: number; sha256: string; file: string }[];
  /** Tables the classification says to back up that do not exist in this database (created by a service on first use). */
  missing: string[];
}

export async function logicalBackup(db: pg.Pool, dir: string, o: { kinds?: readonly TableKind[]; now?: () => Date } = {}): Promise<Manifest> {
  const kinds = o.kinds ?? ['backup', 'derived'];
  mkdirSync(dir, { recursive: true });
  const have = new Set(await existingTables(db));
  const wanted = Object.entries(TABLE_CLASS).filter(([, c]) => kinds.includes(c.kind)).map(([t, c]) => [t, c.kind] as const);
  const tables: Manifest['tables'] = [];
  const missing: string[] = [];
  for (const [t, kind] of wanted) {
    if (!have.has(t)) {
      missing.push(t);
      continue;
    }
    const lines = await rowLines(db, t);
    const file = `${t}.ndjson`;
    writeFileSync(join(dir, file), lines.map((l) => l + '\n').join(''));
    tables.push({ name: t, kind, rows: lines.length, sha256: sha(lines.join('\n')), file });
  }
  const manifest: Manifest = { schema: 'opening-cross/backup/v1', createdAt: (o.now?.() ?? new Date()).toISOString(), kinds: [...kinds], tables, missing };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export interface RestoreReport {
  restored: { name: string; rows: number }[];
  /** In the backup but with no table in the target: start the service that creates it, then restore again. */
  skipped: string[];
}

/**
 * Loads a backup into a database whose tables already exist (run the migrations, and start any service that creates its own table,
 * first). It refuses a backup whose files do not match their recorded digests, and a target table that is not empty.
 */
export async function logicalRestore(db: pg.Pool, dir: string): Promise<RestoreReport> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.schema !== 'opening-cross/backup/v1') throw new Error(`unknown backup schema ${manifest.schema}`);
  const have = new Set(await existingTables(db));
  // Verify every file before touching the database.
  const loaded = manifest.tables.map((t) => {
    const text = readFileSync(join(dir, t.file), 'utf8');
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    if (lines.length !== t.rows) throw new Error(`${t.file} has ${lines.length} rows, the manifest says ${t.rows}`);
    if (sha(lines.join('\n')) !== t.sha256) throw new Error(`${t.file} does not match its recorded digest; the backup is damaged`);
    return { t, lines };
  });
  const restored: RestoreReport['restored'] = [];
  const skipped: string[] = [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const order = await foreignKeyOrder(client, loaded);
    for (const { t, lines } of order) {
      if (!have.has(t.name)) {
        skipped.push(t.name);
        continue;
      }
      const n = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q(t.name)}`)).rows[0]!.n;
      if (n !== '0') throw new Error(`${t.name} already holds ${n} rows; restore into an empty database`);
      for (let i = 0; i < lines.length; i += 500) {
        await client.query(`INSERT INTO ${q(t.name)} SELECT * FROM json_populate_recordset(null::${q(t.name)}, $1::json)`, [`[${lines.slice(i, i + 500).join(',')}]`]);
      }
      // Rows loaded with their own serial numbers leave the sequence at 1; the next insert would collide with a restored row.
      for (const col of (await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_default LIKE 'nextval(%'", [t.name])).rows) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), coalesce((SELECT max(${q(col.column_name)}) FROM ${q(t.name)}), 0) + 1, false)`, [t.name, col.column_name]);
      }
      restored.push({ name: t.name, rows: lines.length });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { restored, skipped };
}

/** Parents before children, from the foreign keys the database itself reports. */
async function foreignKeyOrder<T extends { t: { name: string } }>(client: pg.PoolClient, items: readonly T[]): Promise<T[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
      WHERE k.contype = 'f' AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
  );
  const names = new Set(items.map((i) => i.t.name));
  const parents = new Map<string, Set<string>>();
  for (const r of rows) {
    if (names.has(r.child) && names.has(r.parent) && r.child !== r.parent) (parents.get(r.child) ?? parents.set(r.child, new Set()).get(r.child)!).add(r.parent);
  }
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (name: string, stack: string[]) => {
    if (done.has(name)) return;
    if (stack.includes(name)) throw new Error(`foreign keys form a cycle through ${[...stack, name].join(' -> ')}`);
    for (const p of parents.get(name) ?? []) visit(p, [...stack, name]);
    done.add(name);
    out.push(items.find((i) => i.t.name === name)!);
  };
  for (const i of items) visit(i.t.name, []);
  return out;
}

/** Table names defined anywhere under the given directories, from CREATE TABLE statements in .sql and .ts files. */
export function tablesDefinedIn(roots: readonly string[]): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f === 'dist' || f === '.git') continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(sql|ts)$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)\s*\(/g)) found.add(m[1]!);
    }
  };
  roots.forEach(walk);
  return [...found].sort();
}
