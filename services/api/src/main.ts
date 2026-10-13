// API process: DATABASE_URL (the indexer's database) and RPC_URL are required; PORT and HOST
// default to 8080 and 0.0.0.0. RATE_LIMIT_PER_MINUTE (default 600, 0 turns it off) limits requests per client address;
// OWN_WALLETS (optional, comma-separated addresses) lists wallets we operate so /v1/metrics/external-flow can exclude them;
// set TRUST_PROXY=1 behind a reverse proxy so the address is the client's, not the proxy's.
import { type Address, fetchEncodedAccount, isAddress } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc, migrate } from '@opening-cross/indexer';
import { parseOwnWallets } from './metrics.js';
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
  ownWallets: parseOwnWallets(process.env.OWN_WALLETS, isAddress),
  warmMetrics: true,
  rateLimit: { perWindow: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) },
  ...(process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' ? { trustProxy: true } : {}),
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
