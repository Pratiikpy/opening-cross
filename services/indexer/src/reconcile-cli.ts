// One-shot reconciliation: compares every indexed cross and order with the chain and prints the drift as JSON.
// DATABASE_URL and RPC_URL are required; exits 1 if any drift survives catching up, 0 when the index equals the chain.
//   COMMITMENT=finalized (default) | confirmed     ATTEMPTS=3 (catch-up rounds)     WAIT_MS=10000 (between rounds)
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from './rpc.js';
import { pollOnce } from './rpc-source.js';
import { reconcileSettled } from './reconcile.js';

const { DATABASE_URL, RPC_URL } = process.env;
if (!DATABASE_URL || !RPC_URL) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const commitment = process.env.COMMITMENT === 'confirmed' ? 'confirmed' : 'finalized';
const db = new pg.Pool({ connectionString: DATABASE_URL });
const rpc = createIndexerRpc(RPC_URL);
const fetcher = async (a: Address) => {
  const acct = await fetchEncodedAccount(rpc, a, { commitment });
  return acct.exists ? acct.data : null;
};
const { rows } = await db.query('SELECT count(*)::int AS crosses FROM crosses');
const drift = await reconcileSettled(db, fetcher, () => pollOnce(db, rpc), {
  attempts: Number(process.env.ATTEMPTS ?? 3),
  waitMs: Number(process.env.WAIT_MS ?? 10_000),
});
console.log(JSON.stringify({ at: new Date().toISOString(), commitment, crossesCompared: rows[0].crosses, driftCount: drift.length, drift }, null, 2));
await db.end();
process.exit(drift.length === 0 ? 0 : 1);
