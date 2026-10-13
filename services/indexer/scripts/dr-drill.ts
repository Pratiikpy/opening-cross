// A disaster-recovery drill on real devnet data, in four steps, each of which can fail:
//   1. SOURCE   read N finished crosses from devnet into a database with the indexer's own ingestion
//   2. BACKUP   logical backup of every table, restore into an empty database, digests of every table equal
//   3. REBUILD  a database built again from the chain alone, from nothing; digests of the chain tables equal the source
//   4. LIVE     the rebuilt database agrees with the deployed API on each cross (state, clearing price, matched, order fills)
//
//   DATABASE_URL=postgres://... [API_URL=https://...] [CROSSES=addr,addr,...] tsx scripts/dr-drill.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createIndexerRpc, logicalBackup, logicalRestore, migrate, pollOnce, tableDigests, TABLE_CLASS } from '../src/index.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const API = (process.env.API_URL ?? 'https://98-87-59-136.sslip.io').replace(/\/$/, '');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const schemas: string[] = [];
async function open(): Promise<pg.Pool> {
  const name = `dr_${randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${name}`);
  schemas.push(name);
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${name}` });
  await migrate(db);
  return db;
}
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(JSON.stringify({ check: label, ok, ...(ok ? {} : { detail }) }));
  if (!ok) failed += 1;
};

let crosses = (process.env.CROSSES ?? '').split(',').filter(Boolean);
if (crosses.length === 0) {
  const r = (await (await fetch(`${API}/v1/crosses?state=Finalized&limit=5`)).json()) as { crosses?: { address: string }[] } | { address: string }[];
  const list = Array.isArray(r) ? r : (r.crosses ?? []);
  crosses = list.map((c) => c.address).slice(0, 3);
}
console.log(JSON.stringify({ drill: 'dr', crosses }));

async function ingest(db: pg.Pool, tag: string) {
  const rpc = createIndexerRpc(RPC);
  let events = 0;
  for (const c of crosses) events += await pollOnce(db, rpc, c as never, `${tag}:${c}`);
  return events;
}

// 1. SOURCE
const source = await open();
const events = await ingest(source, 'drill');
const counts = Object.fromEntries((await Promise.all(['crosses', 'orders', 'events'].map(async (t) => [t, (await source.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n] as const))));
console.log(JSON.stringify({ step: 'source', eventsApplied: events, ...counts }));
check('the source has the crosses', counts.crosses === crosses.length && counts.events! > 0, counts);

// 2. BACKUP and RESTORE of every table, chain tables included
const dir = mkdtempSync(join(tmpdir(), 'oc-drill-'));
const manifest = await logicalBackup(source, dir, { kinds: ['chain', 'derived', 'backup', 'cache'] });
console.log(JSON.stringify({ step: 'backup', dir, tables: manifest.tables.filter((t) => t.rows > 0).map((t) => `${t.name}:${t.rows}`), missing: manifest.missing.length }));
const restored = await open();
const rep = await logicalRestore(restored, dir);
const names = manifest.tables.map((t) => t.name);
const a = await tableDigests(source, names);
const b = await tableDigests(restored, names);
check('every table of the restored database equals the source (rows and sha-256)', JSON.stringify(a) === JSON.stringify(b), names.filter((n) => JSON.stringify(a[n]) !== JSON.stringify(b[n])));
console.log(JSON.stringify({ step: 'restored', tables: rep.restored.length, rows: rep.restored.reduce((s, r) => s + r.rows, 0) }));

// 3. REBUILD from the chain alone
const rebuilt = await open();
await ingest(rebuilt, 'drill');
const chainTables = Object.entries(TABLE_CLASS).filter(([, c]) => c.kind === 'chain').map(([t]) => t).filter((t) => names.includes(t) && a[t]!.rows > 0);
const ra = await tableDigests(source, chainTables);
const rb = await tableDigests(rebuilt, chainTables);
check(`a database rebuilt from the chain alone equals the source on ${chainTables.join(', ')}`, JSON.stringify(ra) === JSON.stringify(rb), chainTables.filter((n) => JSON.stringify(ra[n]) !== JSON.stringify(rb[n])).map((n) => ({ table: n, source: ra[n], rebuilt: rb[n] })));

// 4. AGREE with the deployed API
for (const c of crosses) {
  const live = (await (await fetch(`${API}/v1/crosses/${c}`)).json()) as Record<string, unknown>;
  const row = (await rebuilt.query('SELECT state, clearing_price::text AS price, matched::text AS matched, orders_committed FROM crosses WHERE address = $1', [c])).rows[0];
  const liveOrders = (await (await fetch(`${API}/v1/crosses/${c}/orders`)).json()) as { orders?: { fill?: string | null; status: string }[] } | { fill?: string | null; status: string }[];
  const list = Array.isArray(liveOrders) ? liveOrders : (liveOrders.orders ?? []);
  const mine = (await rebuilt.query('SELECT status, coalesce(fill::text, \'\') AS fill FROM orders WHERE cross_address = $1 ORDER BY idx', [c])).rows;
  const liveFills = list.map((o) => `${o.status}:${o.fill ?? ''}`).sort().join(',');
  const myFills = mine.map((o: { status: string; fill: string }) => `${o.status}:${o.fill}`).sort().join(',');
  const lc = (live.clearing ?? {}) as { price?: string; matched?: string };
  const c1 = live.state === row.state && String(lc.price ?? '') === String(row.price ?? '') && String(lc.matched ?? '') === String(row.matched ?? '');
  check(`${c.slice(0, 8)}: state, clearing price and matched volume agree with the deployed API`, c1, { live: { state: live.state, clearing: live.clearing }, rebuilt: row });
  check(`${c.slice(0, 8)}: ${mine.length} orders and their fills agree with the deployed API`, liveFills === myFills, { liveFills, myFills });
}

for (const s of schemas) await admin.query(`DROP SCHEMA ${s} CASCADE`);
await admin.end();
process.exit(failed === 0 ? 0 : 1);
