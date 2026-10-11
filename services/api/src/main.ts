// API process: DATABASE_URL (the indexer's database) and RPC_URL are required; PORT and HOST
// default to 8080 and 0.0.0.0.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc, migrate } from '@opening-cross/indexer';
import { buildServer } from './server.js';

const { DATABASE_URL, RPC_URL } = process.env;
if (!DATABASE_URL || !RPC_URL) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DATABASE_URL });
const rpc = createIndexerRpc(RPC_URL);
await migrate(db);
const app = await buildServer({
  db,
  network: process.env.NETWORK ?? 'devnet',
  ...(process.env.PROMISE_SIGNER ? { promiseSigner: process.env.PROMISE_SIGNER } : {}),
  ...(process.env.CORS_ORIGINS ? { corsOrigins: process.env.CORS_ORIGINS.split(',') } : {}),
  account: async (a: Address) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
  lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value,
  listen: async () => {
    const c = new pg.Client({ connectionString: DATABASE_URL });
    await c.connect();
    return c;
  },
});
const address = await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });
console.log(JSON.stringify({ at: new Date().toISOString(), listening: address }));
