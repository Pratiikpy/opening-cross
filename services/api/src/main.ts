// API process: DATABASE_URL (the indexer's database) and RPC_URL are required; PORT and HOST
// default to 8080 and 0.0.0.0. RATE_LIMIT_PER_MINUTE (default 600, 0 turns it off) limits requests per client address;
// OWN_WALLETS (optional, comma-separated addresses) lists wallets we operate so /v1/metrics/external-flow can exclude them;
// set TRUST_PROXY=1 behind a reverse proxy so the address is the client's, not the proxy's.
import { type Address, fetchEncodedAccounts, isAddress } from '@solana/kit';
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
// The public cluster endpoint answers bursts with 429 while the indexer, keeper, promiser and pages share it: repeat a read a few
// times with growing pauses, and let simultaneous reads of one account share a single request. No result is kept, so a read is
// never older than the call that made it.
type Read = { data: Uint8Array; owner: Address } | null;
const inflight = new Map<string, Promise<Read>>();
// Reads asked for within a few milliseconds of each other (the cross, its book and every shard for one page) travel as one
// getMultipleAccounts call: one request against the endpoint's limit instead of one per account.
const waiting = new Map<Address, { resolve: (r: Read) => void; reject: (e: unknown) => void }[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
async function flush() {
  flushTimer = null;
  const batch = [...waiting.entries()];
  waiting.clear();
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const found = await fetchEncodedAccounts(rpc, chunk.map(([a]) => a), { commitment: 'confirmed' });
          chunk.forEach(([, waiters], j) => {
            const x = found[j]!;
            const value: Read = x.exists ? { data: x.data, owner: x.programAddress } : null;
            for (const w of waiters) w.resolve(value);
          });
          return;
        } catch (e) {
          const busy = /429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {})}`);
          if (!busy || attempt >= 5) {
            for (const [, waiters] of chunk) for (const w of waiters) w.reject(e);
            return;
          }
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        }
      }
    })();
  }
}
function readAccount(a: Address): Promise<Read> {
  const hit = inflight.get(a);
  if (hit) return hit;
  const run = new Promise<Read>((resolve, reject) => {
    const list = waiting.get(a) ?? [];
    list.push({ resolve, reject });
    waiting.set(a, list);
    flushTimer ??= setTimeout(() => void flush(), 5);
  }).finally(() => inflight.delete(a));
  inflight.set(a, run);
  return run;
}
const app = await buildServer({
  db,
  network: process.env.NETWORK ?? 'devnet',
  ownWallets: parseOwnWallets(process.env.OWN_WALLETS, isAddress),
  warmMetrics: true,
  rateLimit: { perWindow: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) },
  ...(process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' ? { trustProxy: true } : {}),
  ...(process.env.PROMISE_SIGNER ? { promiseSigner: process.env.PROMISE_SIGNER } : {}),
  ...(process.env.CORS_ORIGINS ? { corsOrigins: process.env.CORS_ORIGINS.split(',') } : {}),
  account: readAccount,
  lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value,
  listen: async () => {
    const c = new pg.Client({ connectionString: DATABASE_URL });
    await c.connect();
    return c;
  },
});
const address = await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });
console.log(JSON.stringify({ at: new Date().toISOString(), listening: address }));
