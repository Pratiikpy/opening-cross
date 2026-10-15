// Postgres access for receipt attestations (row S2, ADR-0941). The tables are created on first use, like the alert and gate tables, so a deployment needs no extra migration step; the
// promiser writes them and the API reads them from the same database.
import { type Digest, merkleProof, merkleRoot } from '@opening-cross/promises';
import { type SignedReceiptAttestation, receiptMemoText } from './receipt-attestation.js';

/** What the store needs from Postgres: `pg.Pool` and PGlite both fit. */
export type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS receipt_attestations (
     id              text PRIMARY KEY,
     cluster         text   NOT NULL,
     cross_address   text   NOT NULL,
     receipt_sha256  text   NOT NULL,
     receipt_schema  text   NOT NULL,
     state           text   NOT NULL,
     signer          text   NOT NULL,
     signature       text   NOT NULL,
     body            jsonb  NOT NULL,
     recorded_at     bigint NOT NULL,
     checked_at      bigint NOT NULL,
     UNIQUE (cluster, cross_address, receipt_sha256)
   )`,
  `CREATE INDEX IF NOT EXISTS receipt_attestations_cross ON receipt_attestations (cluster, cross_address, recorded_at DESC)`,
  `CREATE TABLE IF NOT EXISTS receipt_anchors (
     id          bigserial PRIMARY KEY,
     cluster     text    NOT NULL,
     root        text    NOT NULL,
     count       integer NOT NULL,
     signature   text    NOT NULL,
     slot        bigint,
     block_time  bigint,
     UNIQUE (cluster, root)
   )`,
  `CREATE TABLE IF NOT EXISTS receipt_anchor_members (
     anchor_id       bigint NOT NULL REFERENCES receipt_anchors(id),
     attestation_id  text   NOT NULL REFERENCES receipt_attestations(id),
     PRIMARY KEY (attestation_id)
   )`,
];

const ready = new WeakMap<object, Promise<void>>();
/** Creates the tables once per connection pool. A failure is not remembered, so the next call tries again. */
export function ensureReceiptTables(db: Queryable): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = (async () => {
      for (const sql of SCHEMA) await db.query(sql);
    })().catch((e) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}

const num = (v: unknown): number => Number(v);
const nullable = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Terminal crosses (finalized, or settled without a print) that have no attestation yet, oldest first, leaving out `exclude` (crosses a round has just failed on and is waiting to try again). */
export async function crossesToAttest(db: Queryable, cluster: string, limit: number, exclude: readonly string[] = []): Promise<string[]> {
  await ensureReceiptTables(db);
  const { rows } = await db.query(
    `SELECT c.address FROM crosses c
      WHERE c.state IN ('Finalized', 'NoPrint') AND NOT EXISTS (SELECT 1 FROM receipt_attestations a WHERE a.cluster = $1 AND a.cross_address = c.address) AND c.address <> ALL($3::text[])
      ORDER BY c.created_slot LIMIT $2`,
    [cluster, limit, [...exclude]],
  );
  return rows.map((r) => String(r.address));
}

/** Attested crosses not looked at since `before`, least recently checked first: a receipt is checked again in case the bytes served for the cross have changed. */
export async function crossesToRecheck(db: Queryable, cluster: string, before: number, limit: number): Promise<string[]> {
  await ensureReceiptTables(db);
  const { rows } = await db.query(
    `SELECT cross_address FROM (SELECT cross_address, max(checked_at) AS last FROM receipt_attestations WHERE cluster = $1 GROUP BY cross_address) t WHERE last < $2 ORDER BY last LIMIT $3`,
    [cluster, before, limit],
  );
  return rows.map((r) => String(r.cross_address));
}

/** Stores an attestation. A second attestation of the same receipt hash is not stored again; its check time is refreshed. Returns whether a new row was written. */
export async function insertAttestation(db: Queryable, cluster: string, a: SignedReceiptAttestation, now: number): Promise<boolean> {
  await ensureReceiptTables(db);
  const have = await db.query('SELECT id FROM receipt_attestations WHERE cluster = $1 AND cross_address = $2 AND receipt_sha256 = $3', [cluster, a.body.cross, a.body.receiptSha256]);
  if (have.rows.length > 0) {
    await db.query('UPDATE receipt_attestations SET checked_at = $2 WHERE id = $1', [String(have.rows[0]!.id), now]);
    return false;
  }
  await db.query(
    `INSERT INTO receipt_attestations (id, cluster, cross_address, receipt_sha256, receipt_schema, state, signer, signature, body, recorded_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10) ON CONFLICT (id) DO NOTHING`,
    [a.id, cluster, a.body.cross, a.body.receiptSha256, a.body.receiptSchema, a.body.state, a.signer, a.signature, JSON.stringify(a.body), now],
  );
  return true;
}

/** The newest attestation's receipt hash for a cross, or null. */
export async function latestReceiptHash(db: Queryable, cluster: string, cross: string): Promise<string | null> {
  await ensureReceiptTables(db);
  const { rows } = await db.query('SELECT receipt_sha256 FROM receipt_attestations WHERE cluster = $1 AND cross_address = $2 ORDER BY recorded_at DESC, id LIMIT 1', [cluster, cross]);
  return rows[0] ? String(rows[0].receipt_sha256) : null;
}

export async function markChecked(db: Queryable, cluster: string, cross: string, now: number): Promise<void> {
  await ensureReceiptTables(db);
  await db.query('UPDATE receipt_attestations SET checked_at = $3 WHERE cluster = $1 AND cross_address = $2', [cluster, cross, now]);
}

// ------------------------------------------------------------------------------------------------ anchors

export async function unanchoredAttestationIds(db: Queryable, cluster: string): Promise<string[]> {
  await ensureReceiptTables(db);
  const { rows } = await db.query(
    `SELECT a.id FROM receipt_attestations a WHERE a.cluster = $1 AND NOT EXISTS (SELECT 1 FROM receipt_anchor_members m WHERE m.attestation_id = a.id) ORDER BY a.recorded_at, a.id`,
    [cluster],
  );
  return rows.map((r) => String(r.id));
}

/** Records an anchor and its members in one statement, so a crash cannot leave an anchor without them. */
export async function recordReceiptAnchor(db: Queryable, cluster: string, d: Digest, ids: readonly string[], tx: { signature: string; slot: number | null; blockTime: number | null }): Promise<void> {
  await ensureReceiptTables(db);
  await db.query(
    `WITH a AS (
       INSERT INTO receipt_anchors (cluster, root, count, signature, slot, block_time) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cluster, root) DO UPDATE SET signature = receipt_anchors.signature RETURNING id
     )
     INSERT INTO receipt_anchor_members (anchor_id, attestation_id) SELECT a.id, m FROM a, unnest($7::text[]) AS m ON CONFLICT DO NOTHING`,
    [cluster, d.root, d.count, tx.signature, tx.slot, tx.blockTime, [...ids]],
  );
}

export interface ReceiptAnchor {
  readonly root: string;
  readonly count: number;
  /** The Memo transaction that wrote the root. */
  readonly signature: string;
  readonly slot: number | null;
  readonly blockTime: number | null;
  /** The memo text the transaction must carry. */
  readonly memo: string;
  readonly proof: ReturnType<typeof merkleProof>;
}

export interface ReceiptAttestationView {
  readonly attestation: SignedReceiptAttestation;
  readonly recordedAt: number;
  readonly anchor: ReceiptAnchor | null;
  /** How many attestations exist for this cross: more than one means the receipt's bytes changed once it had been attested. */
  readonly attestations: number;
}

/** The newest attestation of a cross with the anchor that covers it, or null. Throws if the stored members no longer hash to the anchored root. */
export async function attestationFor(db: Queryable, cluster: string, cross: string): Promise<ReceiptAttestationView | null> {
  await ensureReceiptTables(db);
  const { rows } = await db.query(
    `SELECT id, signer, signature, body, recorded_at, (SELECT count(*)::int FROM receipt_attestations x WHERE x.cluster = $1 AND x.cross_address = $2) AS n
       FROM receipt_attestations WHERE cluster = $1 AND cross_address = $2 ORDER BY recorded_at DESC, id LIMIT 1`,
    [cluster, cross],
  );
  const r = rows[0];
  if (!r) return null;
  const id = String(r.id);
  const body = (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as SignedReceiptAttestation['body'];
  const attestation: SignedReceiptAttestation = { body, id, signer: String(r.signer), signature: String(r.signature) };
  const a = (
    await db.query(
      `SELECT x.id, x.root, x.count, x.signature, x.slot, x.block_time FROM receipt_anchors x JOIN receipt_anchor_members m ON m.anchor_id = x.id WHERE m.attestation_id = $1 LIMIT 1`,
      [id],
    )
  ).rows[0];
  let anchor: ReceiptAnchor | null = null;
  if (a) {
    const members = (await db.query('SELECT attestation_id FROM receipt_anchor_members WHERE anchor_id = $1', [a.id])).rows.map((m) => String(m.attestation_id));
    const root = String(a.root);
    if (merkleRoot(members) !== root) throw new Error(`receipt anchor ${String(a.id)}: stored members no longer hash to the anchored root`);
    anchor = { root, count: num(a.count), signature: String(a.signature), slot: nullable(a.slot), blockTime: nullable(a.block_time), memo: receiptMemoText({ root, count: num(a.count) }), proof: merkleProof(members, id) };
  }
  return { attestation, recordedAt: num(r.recorded_at), anchor, attestations: num(r.n) };
}
