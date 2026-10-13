// A real routed order and a real signed intent on devnet. The routes run on a local port reading devnet; the wallet is the market-maker
// run's taker. Each unsigned transaction the routes return is signed by the wallet and sent, and the orders are read back from chain.
//   DATABASE_URL=postgres://... tsx scripts/execute-devnet.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import { createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { createApiClient, createRpcClient, signSendConfirm } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';
import { keyPairFromSolanaFile } from '@opening-cross/attest';
import { migrate } from '@opening-cross/indexer';
import { INTENT_SCHEMA, signIntent } from '@opening-cross/liquidity';
import { RequestError } from '../src/tx.js';
import { registerExecute } from '../src/routes/execute.js';

const KEYS = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), '.keys');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
process.env.RPC_URL = RPC;
const run = JSON.parse(readFileSync(join(KEYS, 'mm-run.json'), 'utf8')) as { cross: string; baseMint: string; quoteMint: string };
const rpc = createSolanaRpc(RPC);
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
const live = createApiClient({ baseUrl: API });
const detail = await live.getCross(run.cross);
await db.query('DELETE FROM crosses WHERE address = $1', [run.cross]);
await db.query(
  `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
   VALUES ($1,$2,1,0,1,$3,$4,$5,$6,$6,0,0,'Live',1,1)`,
  [run.cross, detail.creator, run.baseMint, run.quoteMint, detail.window.openTs, detail.window.closeTs],
);

const app = Fastify();
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message, ...err.detail });
  // The same mapping as the API's own handler: a busy cluster endpoint is a 503 to retry.
  const upstream = /429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(err)} ${JSON.stringify((err as { context?: unknown }).context ?? {})}`);
  return upstream ? reply.code(503).send({ error: 'the Solana RPC endpoint is busy or unreachable; retry in a few seconds' }) : reply.code(500).send({ error: String(err) });
});
registerExecute(app, {
  db,
  network: 'devnet',
  account: async (a) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
  lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value as never,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const wallet = await loadKeypairSigner(join(KEYS, 'mm-taker-devnet.json'));
const rpcc = createRpcClient({ url: RPC });
const post = async (path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

// 1. A routed buy of 20 tokens.
const routed = await post('/v1/route/execute', { base: run.baseMint, quote: run.quoteMint, side: 'buy', amount: '20000000', owner: wallet.address });
console.log(show({ step: 'route/execute', status: routed.status, venue: routed.body.venue, cross: routed.body.cross, limit: routed.body.limit, escrow: routed.body.escrow, preflight: routed.body.preflight && { err: routed.body.preflight.err, unitsConsumed: routed.body.preflight.unitsConsumed }, excluded: routed.body.ranking?.excluded?.map((e: { venue: string; reason: string }) => `${e.venue}: ${e.reason.slice(0, 70)}`), best: routed.body.ranking?.venues?.[0] && { pricePerBase: routed.body.ranking.venues[0].pricePerBase, fill: routed.body.ranking.venues[0].fill } }));
if (routed.status !== 200) process.exit(1);
console.log(show({ step: 'signed and sent', signatures: await signSendConfirm([{ transaction: routed.body.transaction, signers: routed.body.signers }], { rpc: rpcc, sign: wallet.sign }) }));

// 2. A signed intent: "buy 10 tokens of this pair at no more than 1.70", executed when a cross is open.
const { keyPair } = await keyPairFromSolanaFile(readFileSync(join(KEYS, 'mm-taker-devnet.json'), 'utf8'));
const intent = await signIntent({ schema: INTENT_SCHEMA, owner: wallet.address, baseMint: run.baseMint, quoteMint: run.quoteMint, side: 'buy', quantity: '10000000', limitPrice: '1700000', expiresAt: Math.floor(Date.now() / 1000) + 1800, nonce: randomBytes(8).toString('hex') }, keyPair);
console.log(show({ step: 'intent stored', ...(await post('/v1/intents', intent)) }));
const forged = { ...intent, body: { ...intent.body, quantity: '99000000' } };
console.log(show({ step: 'forged intent refused', status: (await post('/v1/intents', forged)).status }));
let exec = await post(`/v1/intents/${intent.id}/execute`);
for (let i = 0; i < 4 && exec.status === 503; i++) {
  await new Promise((r) => setTimeout(r, 5_000));
  exec = await post(`/v1/intents/${intent.id}/execute`);
}
if (exec.status >= 400) console.log(show({ error: exec.body }));
console.log(show({ step: 'intent/execute', status: exec.status, venue: exec.body.venue, cross: exec.body.cross, limit: exec.body.limit, escrow: exec.body.escrow }));
if (exec.status !== 200) process.exit(1);
console.log(show({ step: 'signed and sent', signatures: await signSendConfirm([{ transaction: exec.body.transaction, signers: exec.body.signers }], { rpc: rpcc, sign: wallet.sign }) }));

await new Promise((r) => setTimeout(r, 3_000));
const after = await live.getCross(run.cross);
const book = await live.getBook(run.cross);
console.log(show({ step: 'chain', orders: after.orders, indicative: book.indicative, levels: book.levels }));
await app.close();
await db.end();
