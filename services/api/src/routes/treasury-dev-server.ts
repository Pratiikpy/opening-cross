// A local API process for the treasury routes: the same wiring as main.ts (DATABASE_URL and RPC_URL required, PORT default 8080)
// with registerTreasury added, so the routes can be exercised against a real cluster and database before they are wired into
// buildServer. Once `registerTreasury(app, d)` is added to server.ts, main.ts serves the same routes and this file is not needed.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc, migrate } from '@opening-cross/indexer';
import { buildServer } from '../server.js';
import { registerTreasury } from './treasury.js';

const { DATABASE_URL, RPC_URL } = process.env;
if (!DATABASE_URL || !RPC_URL) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DATABASE_URL });
const rpc = createIndexerRpc(RPC_URL);
await migrate(db);

async function account(a: Address) {
  for (let attempt = 0; ; attempt++) {
    try {
      const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
      return x.exists ? { data: x.data, owner: x.programAddress } : null;
    } catch (e) {
      const busy = /429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {})}`);
      if (!busy || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
}

const app = await buildServer({ db, network: process.env.NETWORK ?? 'devnet', account, lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value });
registerTreasury(app, { db, account, network: process.env.NETWORK ?? 'devnet' });
const listening = await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ at: new Date().toISOString(), listening }));
