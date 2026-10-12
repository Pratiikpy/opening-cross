// Indexer process: DATABASE_URL and RPC_URL from the environment; polls every POLL_MS and
// reconciles every RECONCILE_EVERY polls.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from './rpc.js';
import { migrate } from './ingest.js';
import { pollOnce } from './rpc-source.js';
import { reconcileSettled } from './reconcile.js';

const dbUrl = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL;
if (!dbUrl || !rpcUrl) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const pollMs = Number(process.env.POLL_MS ?? 5_000);
const reconcileEvery = Number(process.env.RECONCILE_EVERY ?? 60);

const db = new pg.Pool({ connectionString: dbUrl });
const rpc = createIndexerRpc(rpcUrl);
const fetcher = async (a: Address) => {
  const acct = await fetchEncodedAccount(rpc, a, { commitment: 'finalized' });
  return acct.exists ? acct.data : null;
};

await migrate(db);
for (let tick = 0; ; tick++) {
  try {
    const head = await rpc.getSlot({ commitment: 'finalized' }).send();
    const n = await pollOnce(db, rpc);
    // Written only after a poll that finished, so a long backfill or a stuck RPC shows up as an old heartbeat.
    await db.query('INSERT INTO indexer_heartbeat (id, head_slot, polled_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET head_slot = EXCLUDED.head_slot, polled_at = EXCLUDED.polled_at', [head.toString()]);
    if (n) console.log(JSON.stringify({ at: new Date().toISOString(), applied: n }));
    if (tick % reconcileEvery === 0) {
      const drift = await reconcileSettled(db, fetcher, () => pollOnce(db, rpc), { record: true, waitMs: pollMs, attempts: 5 });
      if (drift.length) console.error(JSON.stringify({ at: new Date().toISOString(), drift }));
    }
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
