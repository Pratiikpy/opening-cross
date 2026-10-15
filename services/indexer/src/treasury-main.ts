// Treasury indexer process: DATABASE_URL and RPC_URL from the environment; polls every POLL_MS. ONCE=1 runs a single pass and exits
// (used to index a devnet treasury on demand). The cross_core indexer (main.ts) is a separate process and cursor.
import pg from 'pg';
import { migrate } from './ingest.js';
import { createIndexerRpc } from './rpc.js';
import { pollTreasuryOnce } from './treasury.js';
import { backfillTreasuryMovements } from './treasury-movements.js';

const dbUrl = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL;
if (!dbUrl || !rpcUrl) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const pollMs = Number(process.env.POLL_MS ?? 15_000);
const db = new pg.Pool({ connectionString: dbUrl });
const rpc = createIndexerRpc(rpcUrl);

await migrate(db);
await backfillTreasuryMovements(db);
for (;;) {
  try {
    const n = await pollTreasuryOnce(db, rpc);
    console.log(JSON.stringify({ at: new Date().toISOString(), treasuryEventsApplied: n }));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
    if (process.env.ONCE) process.exitCode = 1;
  }
  if (process.env.ONCE) break;
  await new Promise((r) => setTimeout(r, pollMs));
}
await db.end();
