// The Postgres source against the indexer's real schema, and migration 009 against a table that already holds events.
// Needs DATABASE_URL; each run uses and drops its own schema.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '@opening-cross/indexer';
import { PostgresEventSource } from '../src/index.js';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
if (!url) console.warn('postgres.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

const MIGRATIONS = new URL('../../indexer/migrations/', import.meta.url);

describeDb('events.ingest_id and the Postgres source', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let db: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  const insert = (sig: string, seq: number, slot: number, name: string, cross: string | null, payload: unknown) =>
    db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7)`, [sig, seq, slot, 1_800_000_000 + slot, name, cross, JSON.stringify(payload)]);

  it('numbers events that already exist in chain order, and keeps numbering new ones after them', async () => {
    // The schema as it was before migration 009, with events inserted out of slot order.
    await db.query(readFileSync(new URL('001_init.sql', MIGRATIONS), 'utf8'));
    await insert('sigB', 0, 20, 'OrderCommitted', 'X', { n: 'b' });
    await insert('sigA', 1, 10, 'CrossCreated', 'X', { n: 'a1' });
    await insert('sigA', 0, 10, 'CrossCreated', 'X', { n: 'a0' });
    const sql = readFileSync(new URL('009_event_ingest_order.sql', MIGRATIONS), 'utf8');
    await db.query(sql);
    const { rows } = await db.query<{ n: string; ingest_id: string }>(`SELECT payload->>'n' AS n, ingest_id::text FROM events ORDER BY ingest_id`);
    expect(rows).toEqual([{ n: 'a0', ingest_id: '1' }, { n: 'a1', ingest_id: '2' }, { n: 'b', ingest_id: '3' }]);
    await insert('sigC', 0, 30, 'OrderCommitted', 'X', { n: 'c' });
    const last = await db.query<{ ingest_id: string }>(`SELECT ingest_id::text FROM events WHERE signature = 'sigC'`);
    expect(last.rows[0]!.ingest_id).toBe('4');
    await db.query(sql); // running it again changes nothing
    expect((await db.query(`SELECT count(*)::int AS n FROM events`)).rows[0]!.n).toBe(4);
    expect((await db.query(`SELECT max(ingest_id)::text AS m FROM events`)).rows[0]!.m).toBe('4');
  });

  it('the indexer\'s own migrate applies it, and the source reads in position order with filters and a head', async () => {
    await migrate(db);
    await insert('sigD', 0, 40, 'CrossCreated', 'Y', { cross: 'Y' });
    await insert('sigD', 1, 40, 'OrderCommitted', 'Y', { cross: 'Y' });
    await insert('sigE', 0, 50, 'PauseChanged', null, { paused: true });
    const src = new PostgresEventSource(db);
    const all = await src.next(0n, 100, {});
    expect(all.map((r) => r.position)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(all[4]).toMatchObject({ signature: 'sigD', seq: 0, slot: 40n, blockTime: 1_800_000_040n, name: 'CrossCreated', cross: 'Y', payload: { cross: 'Y' } });
    expect(all[6]).toMatchObject({ cross: null, name: 'PauseChanged', payload: { paused: true } });
    expect((await src.next(5n, 100, {})).map((r) => r.position)).toEqual([6n, 7n]);
    expect((await src.next(0n, 2, {})).map((r) => r.position)).toEqual([1n, 2n]);
    expect((await src.next(0n, 100, { crosses: new Set(['Y']) })).map((r) => r.name)).toEqual(['CrossCreated', 'OrderCommitted']);
    expect((await src.next(0n, 100, { events: new Set(['PauseChanged']) })).map((r) => r.position)).toEqual([7n]);
    expect(await src.head()).toEqual({ position: 7n, events: 7n });
  });

  it('an empty log has head 0', async () => {
    await db.query('DELETE FROM events');
    expect(await new PostgresEventSource(db).head()).toEqual({ position: 0n, events: 0n });
  });
});
