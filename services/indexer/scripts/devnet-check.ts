// Indexes cross_core's full devnet history into DATABASE_URL, kills nothing in between but runs
// the source twice (the second run must apply nothing), then reconciles against devnet.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from '../src/rpc.js';
import { migrate, pollOnce, reconcile } from '../src/index.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rpc = createIndexerRpc(process.env.RPC_URL ?? 'https://api.devnet.solana.com');
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate(db);
const first = await pollOnce(db, rpc);
const second = await pollOnce(db, rpc);
const fetcher = async (a: Address) => { const x = await fetchEncodedAccount(rpc, a, { commitment: 'finalized' }); return x.exists ? x.data : null; };
const drift = await reconcile(db, fetcher);
const { rows } = await db.query(`SELECT (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM crosses)::int AS crosses, (SELECT count(*) FROM orders)::int AS orders, (SELECT last_slot FROM cursors LIMIT 1) AS cursor`);
console.log(JSON.stringify({ firstRun: first, secondRun: second, ...rows[0], drift }, null, 2));
await db.end();
process.exit(second === 0 && drift.length === 0 ? 0 : 1);
