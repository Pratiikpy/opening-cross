// The audit log: append-only, hash-chained. Each entry's hash covers the previous entry's hash and its own content, so an edited or
// removed row breaks every hash after it, and `verifyChain` finds the first row where it breaks. The chain proves the log was not
// altered after the fact by anyone who cannot also rewrite every later row AND the head that was signed and published; the signed head
// (see `signedHead`) is what makes a rewrite visible to someone who kept an earlier copy.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { type Json, canonicalize } from '@opening-cross/promises';
import { type Signed, signDocument } from '@opening-cross/attest';

export const GENESIS = '0'.repeat(64);
export interface Entry {
  seq: number;
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: Json;
  prevHash: string;
  hash: string;
}

export const entryHash = (prev: string, e: { at: number; actor: string; action: string; subject: string; detail: Json }): string =>
  createHash('sha256').update(`${prev}\n${canonicalize({ at: e.at, actor: e.actor, action: e.action, subject: e.subject, detail: e.detail })}`).digest('hex');

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Appends inside the caller's transaction, so a decision and its record commit together or not at all. */
export async function append(db: Queryable, e: { at: number; actor: string; action: string; subject: string; detail: Json }): Promise<Entry> {
  // One writer at a time extends the chain; the lock is released when the transaction ends.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('ops_log'))");
  const last = (await db.query<{ hash: string }>('SELECT hash FROM ops_log ORDER BY seq DESC LIMIT 1')).rows[0]?.hash ?? GENESIS;
  const hash = entryHash(last, e);
  const { rows } = await db.query<{ seq: string }>('INSERT INTO ops_log (at, actor, action, subject, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING seq::text', [e.at, e.actor, e.action, e.subject, JSON.stringify(e.detail), last, hash]);
  return { seq: Number(rows[0]!.seq), ...e, prevHash: last, hash };
}

export interface ChainCheck {
  ok: boolean;
  length: number;
  head: string;
  /** The first entry whose hash does not follow from the one before it, or whose link is wrong. */
  brokenAt?: { seq: number; why: string };
}

// `seq::text` is selected under the name `seq`; ORDER BY must name the table's own column, or Postgres sorts by the text output (1, 10, 11, ..., 2).
export async function verifyChain(db: pg.Pool): Promise<ChainCheck> {
  const { rows } = await db.query<{ seq: string; at: string; actor: string; action: string; subject: string; detail: Json; prev_hash: string; hash: string }>('SELECT seq::text, at::text, actor, action, subject, detail, prev_hash, hash FROM ops_log ORDER BY ops_log.seq');
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, length: rows.length, head: prev, brokenAt: { seq: Number(r.seq), why: 'it does not follow the entry before it (an entry was removed or inserted)' } };
    const expect = entryHash(prev, { at: Number(r.at), actor: r.actor, action: r.action, subject: r.subject, detail: r.detail });
    if (expect !== r.hash) return { ok: false, length: rows.length, head: prev, brokenAt: { seq: Number(r.seq), why: 'its content does not match its hash (it was edited)' } };
    prev = r.hash;
  }
  return { ok: true, length: rows.length, head: prev };
}

export async function entries(db: pg.Pool, o: { after?: number; limit?: number } = {}): Promise<Entry[]> {
  const { rows } = await db.query<{ seq: string; at: string; actor: string; action: string; subject: string; detail: Json; prev_hash: string; hash: string }>('SELECT seq::text, at::text, actor, action, subject, detail, prev_hash, hash FROM ops_log WHERE seq > $1 ORDER BY ops_log.seq LIMIT $2', [o.after ?? 0, Math.min(500, o.limit ?? 100)]);
  return rows.map((r) => ({ seq: Number(r.seq), at: Number(r.at), actor: r.actor, action: r.action, subject: r.subject, detail: r.detail, prevHash: r.prev_hash, hash: r.hash }));
}

export const HEAD_SCHEMA = 'opening-cross/ops-log-head/v1';
/** The head of the chain, signed by the operator key, to be published somewhere the operator cannot quietly rewrite. */
export async function signedHead(db: pg.Pool, keyPair: CryptoKeyPair, now: number): Promise<{ check: ChainCheck; document: Signed<{ schema: typeof HEAD_SCHEMA; head: string; length: number; at: number }> | null }> {
  const check = await verifyChain(db);
  if (!check.ok) return { check, document: null };
  return { check, document: await signDocument({ schema: HEAD_SCHEMA, head: check.head, length: check.length, at: now }, keyPair) };
}
