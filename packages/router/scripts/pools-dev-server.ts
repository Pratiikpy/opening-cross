// A small API for looking at the pool screens against the real network: the pool routes of services/api/src/routes/pools.ts (and the dashboard route that
// carries their section), reading devnet through its public RPC, and a cross index with the three crosses whose markets the devnet proofs opened.
//
// Not a second API and not a stand-in for one. The pool routes answer from chain exactly as they do in the full server; the only thing seeded is the index
// the `summary` route lists from, and its rows are the crosses of docs/evidence/A2-damm-v2-devnet.md, A3-dlmm-devnet.md and D5-dlmm-conviction-ladder-devnet.md.
//
//   pnpm --filter @opening-cross/api exec tsx ../../packages/router/scripts/pools-dev-server.ts   (listens on PORT, default 8097)
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { RequestError } from '../../../services/api/src/tx.js';
import { registerPools } from '../../../services/api/src/routes/pools.js';
import { registerDashboard } from '../../../services/api/src/routes/dashboard.js';
import { holderDb } from '../../../services/api/test/helpers/holder-pg.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = async (method: string, params: unknown[]) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429 && attempt < 12) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(attempt, 4)));
      continue;
    }
    const body = (await res.json()) as { result?: any; error?: { code?: number } };
    if (body.error?.code === 429 && attempt < 12) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(attempt, 4)));
      continue;
    }
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  }
};

// A real Postgres (PGlite) carrying the indexer's own migrations, as the API tests use.
const db = await holderDb();
const CROSSES: [string, string, string][] = [
  ['BYAZwuKnRyCvgiDcFU2puKC2t6ELUc7hktB7XTJ8brfM', 'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV', '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy'],
  ['E2uWUxMuzzBUVaAadsV8pFdza5ymdQz2BPwC9KT3UNXC', 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN', 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN'],
  ['8fE1rFQ4a6HZtevFKsc2SaeGei1SYLWtiX7LNAnUQNES', 'BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt', 'B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ'],
];
for (const [i, [address, base, quote]] of CROSSES.entries()) {
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, created_slot, updated_slot)
     VALUES ($1, 'creator', 0, 0, 0, $2, $3, 1, $4, $4, 30, 20, 'Finalized', 1300000, 2800000000, 1, 1)`,
    [address, base, quote, 1_790_000_000 + i],
  );
}

const app = Fastify();
await app.register(cors, { origin: true });
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // The same mapping the full server makes: an RPC that keeps answering 429 is the upstream's, not a fault in the request.
  if (/429/.test(String(err))) return reply.code(503).header('retry-after', '5').send({ error: 'the Solana RPC endpoint is busy or unreachable; retry in a few seconds' });
  console.error(String(err));
  return reply.code(500).send({ error: 'internal error' });
});
app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'no such route' }));
registerPools(app, {
  account: async (a) => {
    const r = await rpc('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]);
    return r.value ? { data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')), owner: r.value.owner } : null;
  },
  lifetime: async () => {
    const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
  },
  db: db as never,
  network: 'devnet',
});
registerDashboard(app, { account: async () => null }, { skip: ['programs', 'execution', 'fairness', 'externalFlow', 'accuracy', 'fees', 'protocol', 'ratings', 'health', 'totals'] });
const port = Number(process.env.PORT ?? 8097);
await app.listen({ port, host: '127.0.0.1' });
console.log(`pool routes on http://127.0.0.1:${port} (reading ${RPC})`);
