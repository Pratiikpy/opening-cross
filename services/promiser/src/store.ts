// Postgres access for promises. Everything the API and the public accuracy page show is read from
// here, so the page can never disagree with the stored, signed record.
import type pg from 'pg';
import {
  type Digest,
  type GradedRecord,
  type GradedSample,
  type Grade,
  type OpeningCrossPromise,
  type SignedPromise,
  merkleProof,
  merkleRoot,
  samplesOf,
} from '@opening-cross/promises';
import type { Json } from '@opening-cross/promises';

export async function insertPromise(db: pg.Pool, cluster: string, s: SignedPromise, inputs: Json): Promise<boolean> {
  const p = s.promise;
  const res = await db.query(
    `INSERT INTO promises (id, cluster, cross_address, bucket, issued_at, deadline, signer, signature, body, inputs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    [p.id, cluster, p.subject.cross, p.subject.bucket, p.issuedAt, p.deadline, s.signer, s.signature, JSON.stringify(p), JSON.stringify(inputs)],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface Row {
  readonly signed: SignedPromise;
  readonly grade: Grade | null;
  readonly outcomeAt: number | null;
}

type DbRow = { id: string; signer: string; signature: string; body: OpeningCrossPromise; status: string | null; reason: string | null; outcome_tick: number | null; error_ticks: number | null; interval_score: string | null; graded_at: string | null; outcome_at: string | null };

const SELECT = `SELECT p.id, p.signer, p.signature, p.body, g.status, g.reason, g.outcome_tick, g.error_ticks, g.interval_score, g.graded_at, g.outcome_at
  FROM promises p LEFT JOIN promise_grades g ON g.promise_id = p.id`;

function toRow(r: DbRow): Row {
  return {
    signed: { promise: r.body, signer: r.signer, signature: r.signature },
    grade: r.status
      ? { promiseId: r.id, status: r.status as Grade['status'], reason: r.reason, outcomeTick: r.outcome_tick, errorTicks: r.error_ticks, intervalScoreTicks: r.interval_score === null ? null : Number(r.interval_score), gradedAt: Number(r.graded_at) }
      : null,
    outcomeAt: r.outcome_at === null ? null : Number(r.outcome_at),
  };
}

export async function getPromise(db: pg.Pool, id: string): Promise<Row | null> {
  const { rows } = await db.query(`${SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toRow(rows[0] as DbRow) : null;
}

export async function getInputs(db: pg.Pool, id: string): Promise<Json | null> {
  const { rows } = await db.query('SELECT inputs FROM promises WHERE id = $1', [id]);
  return rows[0] ? (rows[0].inputs as Json) : null;
}

export async function latestForCross(db: pg.Pool, cross: string): Promise<Row | null> {
  const { rows } = await db.query(`${SELECT} WHERE p.cross_address = $1 ORDER BY p.issued_at DESC LIMIT 1`, [cross]);
  return rows[0] ? toRow(rows[0] as DbRow) : null;
}

export async function listForCross(db: pg.Pool, cross: string, limit: number): Promise<Row[]> {
  const { rows } = await db.query(`${SELECT} WHERE p.cross_address = $1 ORDER BY p.issued_at DESC LIMIT $2`, [cross, limit]);
  return (rows as DbRow[]).map(toRow);
}

/** Final grades never change; an UNRESOLVED one may be replaced once the outcome exists. */
export async function upsertGrade(db: pg.Pool, g: Grade, outcomeAt: number | null): Promise<void> {
  await db.query(
    `INSERT INTO promise_grades (promise_id, status, reason, outcome_tick, error_ticks, interval_score, graded_at, outcome_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (promise_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, outcome_tick = EXCLUDED.outcome_tick,
       error_ticks = EXCLUDED.error_ticks, interval_score = EXCLUDED.interval_score, graded_at = EXCLUDED.graded_at, outcome_at = EXCLUDED.outcome_at
     WHERE promise_grades.status = 'UNRESOLVED'`,
    [g.promiseId, g.status, g.reason, g.outcomeTick, g.errorTicks, g.intervalScoreTicks, g.gradedAt, outcomeAt],
  );
}

/** Promises with no final grade yet. */
export async function ungraded(db: pg.Pool, cluster: string): Promise<OpeningCrossPromise[]> {
  const { rows } = await db.query(
    `SELECT p.body FROM promises p LEFT JOIN promise_grades g ON g.promise_id = p.id
     WHERE p.cluster = $1 AND (g.promise_id IS NULL OR g.status = 'UNRESOLVED') ORDER BY p.issued_at`,
    [cluster],
  );
  return rows.map((r) => r.body as OpeningCrossPromise);
}

/** Every graded record on a cluster, for the accuracy report. */
export async function records(db: pg.Pool, cluster: string): Promise<{ rows: GradedRecord[]; outcomeAt: Map<string, number> }> {
  const { rows } = await db.query(`${SELECT} WHERE p.cluster = $1 ORDER BY p.issued_at`, [cluster]);
  const out: GradedRecord[] = [];
  const outcomeAt = new Map<string, number>();
  for (const r of rows as DbRow[]) {
    const row = toRow(r);
    if (!row.grade) continue;
    out.push({ promise: row.signed.promise, grade: row.grade });
    if (row.outcomeAt !== null) outcomeAt.set(r.id, row.outcomeAt);
  }
  return { rows: out, outcomeAt };
}

/** The calibration samples: the last graded promise per cross and bucket whose outcome is known. */
export async function samples(db: pg.Pool, cluster: string): Promise<GradedSample[]> {
  const { rows, outcomeAt } = await records(db, cluster);
  return samplesOf(rows, (id) => outcomeAt.get(id));
}

/** Time the cross cleared on chain, from the indexer's own record of the event. */
export async function clearedAt(db: pg.Pool, cross: string): Promise<number | null> {
  const { rows } = await db.query(`SELECT extract(epoch FROM block_time)::bigint AS t FROM events WHERE cross_address = $1 AND name = 'CrossCleared' ORDER BY slot LIMIT 1`, [cross]);
  return rows[0]?.t === null || rows[0]?.t === undefined ? null : Number(rows[0].t);
}

// ---- anchors

export async function unanchoredIds(db: pg.Pool, cluster: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT p.id FROM promises p WHERE p.cluster = $1 AND NOT EXISTS (SELECT 1 FROM promise_anchor_members m WHERE m.promise_id = p.id) ORDER BY p.issued_at, p.id`,
    [cluster],
  );
  return rows.map((r) => r.id as string);
}

export async function recordAnchor(db: pg.Pool, cluster: string, d: Digest, ids: readonly string[], tx: { signature: string; slot: number | null; blockTime: number | null }): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO promise_anchors (cluster, root, count, signature, slot, block_time) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cluster, root) DO UPDATE SET signature = promise_anchors.signature RETURNING id`,
      [cluster, d.root, d.count, tx.signature, tx.slot, tx.blockTime],
    );
    const id = Number(rows[0].id);
    for (const pid of ids) await client.query('INSERT INTO promise_anchor_members (anchor_id, promise_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid]);
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface AnchorProof {
  readonly root: string;
  readonly count: number;
  readonly signature: string;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly proof: ReturnType<typeof merkleProof>;
}

export async function anchorFor(db: pg.Pool, promiseId: string): Promise<AnchorProof | null> {
  const { rows } = await db.query(
    `SELECT a.id, a.root, a.count, a.signature, a.slot, a.block_time FROM promise_anchors a JOIN promise_anchor_members m ON m.anchor_id = a.id WHERE m.promise_id = $1 LIMIT 1`,
    [promiseId],
  );
  if (!rows[0]) return null;
  const { rows: members } = await db.query('SELECT promise_id FROM promise_anchor_members WHERE anchor_id = $1', [rows[0].id]);
  const ids = members.map((m) => m.promise_id as string);
  if (merkleRoot(ids) !== rows[0].root) throw new Error(`anchor ${rows[0].id}: stored members no longer hash to the anchored root`);
  return { root: rows[0].root, count: rows[0].count, signature: rows[0].signature, slot: rows[0].slot === null ? null : Number(rows[0].slot), blockTime: rows[0].block_time === null ? null : Number(rows[0].block_time), proof: merkleProof(ids, promiseId) };
}
