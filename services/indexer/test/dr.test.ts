import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/ingest.js';
import { TABLE_CLASS, backupTables, existingTables, logicalBackup, logicalRestore, tableDigests, tablesDefinedIn, unclassified } from '../src/dr.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GATE = 'CREATE TABLE IF NOT EXISTS gate_allowlists (mint text PRIMARY KEY, root text NOT NULL, addresses text[] NOT NULL, published_at timestamptz NOT NULL DEFAULT now())';

describe('table classification', () => {
  it('covers every table any migration or service defines, and names no table that does not exist', () => {
    const found = tablesDefinedIn([join(ROOT, 'services'), join(ROOT, 'packages')]);
    expect(found.length).toBeGreaterThan(30);
    expect(unclassified(found), 'a new table must be classified in services/indexer/src/dr.ts (chain, derived, cache or backup)').toEqual([]);
    const stale = Object.keys(TABLE_CLASS).filter((t) => !found.includes(t));
    expect(stale, 'classified but defined nowhere').toEqual([]);
  });
  it('lists the tables a backup must hold', () => {
    const b = backupTables();
    for (const t of ['promises', 'referrals', 'integrity_documents', 'billing_payments', 'gate_allowlists', 'alert_subscriptions']) expect(b).toContain(t);
    for (const t of ['crosses', 'orders', 'events', 'funding_cache', 'token_labels']) expect(b).not.toContain(t);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('dr.test.ts: database tests SKIPPED; set DATABASE_URL to a Postgres to run them');

describeDb('logical backup and restore', () => {
  const schemas: string[] = [];
  let admin: pg.Client;
  const open = async (): Promise<pg.Pool> => {
    const name = `t_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${name}`);
    schemas.push(name);
    const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${name}` });
    await migrate(db);
    return db;
  };
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  async function fill(db: pg.Pool) {
    await db.query(
      `INSERT INTO promises (id, cluster, cross_address, bucket, issued_at, deadline, signer, signature, body, inputs) VALUES
        ('p1','devnet','c1',2,100,200,'signer','sig','{"a":1,"big":12345678901234567890}','[{"price":"1550000"}]'),
        ('p2','devnet','c1',3,101,200,'signer','sig2',$1,'[]')`,
      [JSON.stringify({ unicode: 'héllo', quote: "it's" })],
    );
    await db.query("INSERT INTO promise_grades (promise_id, status, graded_at, interval_score) VALUES ('p1','HIT',300,0.123456789012345678)");
    await db.query(`INSERT INTO referrals (id, owner, referrer, effective_from, nonce, doc) VALUES ('r1','o1',NULL,5,'n1','{"x":[1,2,3]}')`);
    await db.query(`INSERT INTO integrity_documents (id, schema, mint, signer, as_of, doc) VALUES ('d1','s','m','sg',9,'{"k":"v"}')`);
    await db.query('INSERT INTO billing_payments (signature, issuer, plan, amount, paid_at, slot, mint) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['sig1', 'i', 'plan', '99000000000000000000', 5, 6, 'm']);
    await db.query("INSERT INTO token_labels (mint, name, symbol, exists) VALUES ('m','N','S',true)");
    await db.query(GATE);
    await db.query('INSERT INTO gate_allowlists (mint, root, addresses) VALUES ($1,$2,$3)', ['m', 'root', ['a', 'b with space', 'c,d']]);
    for (const [i, h] of ['h1', 'h2'].entries()) await db.query("INSERT INTO ops_log (at, actor, action, subject, detail, prev_hash, hash) VALUES ($1,'a','x','s','{}',$2,$3)", [i, i === 0 ? '0' : 'h1', h]);
  }

  it('restores to exactly what was backed up: every digest equal, every row present', async () => {
    const src = await open();
    await fill(src);
    const dir = mkdtempSync(join(tmpdir(), 'oc-dr-'));
    const manifest = await logicalBackup(src, dir);
    expect(manifest.tables.find((t) => t.name === 'promises')).toMatchObject({ rows: 2, kind: 'backup' });
    expect(manifest.tables.find((t) => t.name === 'promise_grades')).toMatchObject({ rows: 1, kind: 'derived' });
    expect(manifest.tables.some((t) => t.name === 'token_labels')).toBe(false); // a cache is not backed up
    expect(manifest.missing).toContain('alert_subscriptions'); // created by the API on first use, absent here

    const dst = await open();
    await dst.query(GATE);
    const report = await logicalRestore(dst, dir);
    expect(report.restored.map((r) => r.name)).toContain('promises');
    const names = manifest.tables.map((t) => t.name);
    expect(await tableDigests(dst, names)).toEqual(await tableDigests(src, names));
    // The values survive exactly: a number beyond 2^53, a numeric with 18 digits, text with quotes and commas.
    expect((await dst.query('SELECT amount::text AS a FROM billing_payments')).rows[0].a).toBe('99000000000000000000');
    expect((await dst.query('SELECT interval_score::text AS s FROM promise_grades')).rows[0].s).toBe('0.123456789012345678');
    expect((await dst.query('SELECT addresses FROM gate_allowlists')).rows[0].addresses).toEqual(['a', 'b with space', 'c,d']);
    expect((await dst.query("SELECT body->>'quote' AS q FROM promises WHERE id = 'p2'")).rows[0].q).toBe("it's");
    // A serial column keeps counting from where it was: the next insert must not collide with a restored row.
    const next = await dst.query("INSERT INTO ops_log (at, actor, action, subject, detail, prev_hash, hash) VALUES (9,'a','x','s','{}','h2','h3') RETURNING seq::int AS seq");
    expect(next.rows[0].seq).toBe(3);
  });

  it('refuses a damaged backup before it writes anything, and a target that is not empty', async () => {
    const src = await open();
    await fill(src);
    const dir = mkdtempSync(join(tmpdir(), 'oc-dr-'));
    await logicalBackup(src, dir);
    const dst = await open();
    await dst.query(GATE);
    const file = join(dir, 'promises.ndjson');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('"p1"', '"p9"'));
    await expect(logicalRestore(dst, dir)).rejects.toThrow(/does not match its recorded digest/);
    expect((await dst.query('SELECT count(*)::int AS n FROM referrals')).rows[0].n).toBe(0); // nothing was written
    writeFileSync(file, original.split('\n').slice(1).join('\n'));
    await expect(logicalRestore(dst, dir)).rejects.toThrow(/has 1 rows, the manifest says 2/);
    writeFileSync(file, original);
    await logicalRestore(dst, dir);
    await expect(logicalRestore(dst, dir)).rejects.toThrow(/already holds/);
  });

  it('a failure part-way rolls the whole restore back', async () => {
    const src = await open();
    await fill(src);
    const dir = mkdtempSync(join(tmpdir(), 'oc-dr-'));
    await logicalBackup(src, dir);
    const dst = await open();
    await dst.query(GATE);
    await dst.query("INSERT INTO gate_allowlists (mint, root, addresses) VALUES ('x','x','{}')"); // fails the "empty target" rule after other tables loaded
    await expect(logicalRestore(dst, dir)).rejects.toThrow(/gate_allowlists already holds/);
    for (const t of ['promises', 'referrals', 'integrity_documents', 'billing_payments']) expect((await dst.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
  });

  it('notices a difference between two databases', async () => {
    const a = await open();
    const b = await open();
    await fill(a);
    await fill(b);
    expect(await tableDigests(a, ['promises'])).toEqual(await tableDigests(b, ['promises']));
    await b.query("UPDATE promises SET signature = 'tampered' WHERE id = 'p1'");
    const da = await tableDigests(a, ['promises']);
    const db = await tableDigests(b, ['promises']);
    expect(db.promises!.sha256).not.toBe(da.promises!.sha256);
    expect(db.promises!.rows).toBe(da.promises!.rows);
    expect((await existingTables(a)).includes('promises')).toBe(true);
  });
});
