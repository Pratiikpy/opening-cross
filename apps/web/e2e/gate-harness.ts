// A local API for the gate screens: the gate routes (services/api/src/routes/gate.ts) running against devnet, with every other
// /v1 request forwarded to the live API, so the web app sees real crosses and real gates before the routes are mounted there.
// The list of crosses to scan for gates comes from the live API's own /v1/crosses. Allowlists are kept in memory.
//
//   cd services/api && PORT=8099 UPSTREAM=https://98-87-59-136.sslip.io npx tsx ../../apps/web/e2e/gate-harness.ts
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { type Address, createSolanaRpc } from '@solana/kit';
import { registerGate } from '../../../services/api/src/routes/gate.ts';
import { RequestError } from '../../../services/api/src/tx.ts';

const UPSTREAM = process.env.UPSTREAM ?? 'https://98-87-59-136.sslip.io';
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PORT = Number(process.env.PORT ?? 8099);
const rpc = createSolanaRpc(RPC_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= 8 || !/429|Too Many|fetch failed/.test(`${e} ${(e as { cause?: unknown }).cause}`)) throw e;
      await sleep(Math.min(8_000, 400 * 2 ** attempt));
    }
  }
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', methods: ['GET', 'POST'] });
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
  console.error(String(err));
  if (/429|HTTP error|fetch failed/.test(String(err))) return reply.code(503).header('retry-after', '5').send({ error: 'the Solana RPC endpoint is busy or unreachable; retry in a few seconds' });
  return reply.code(500).send({ error: 'internal error' });
});

const memory = new Map<string, { rootHex: string; addresses: Address[] }>();
registerGate(app, {
  db: {
    query: async (_sql: string, params: unknown[]) => {
      const r = await fetch(`${UPSTREAM}/v1/crosses?limit=${Number(params?.[0] ?? 60)}`);
      const b = (await r.json()) as { crosses: { address: string }[] };
      return { rows: b.crosses };
    },
  } as never,
  account: async (a) => {
    const { value } = await retry(() => rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send());
    return value ? { data: new Uint8Array(Buffer.from(value.data[0], 'base64')), owner: value.owner } : null;
  },
  lifetime: async () => (await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send())).value,
  allowlists: { get: async (m) => memory.get(m) ?? null, put: async (m, rootHex, addresses) => void memory.set(m, { rootHex, addresses }) },
});

// Everything else goes to the live API unchanged.
app.setNotFoundHandler(async (req, reply) => {
  const res = await fetch(`${UPSTREAM}${req.url}`, {
    method: req.method,
    headers: { 'content-type': 'application/json' },
    ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
  });
  return reply.code(res.status).type(res.headers.get('content-type') ?? 'application/json').send(Buffer.from(await res.arrayBuffer()));
});

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`gate harness on http://127.0.0.1:${PORT}, forwarding the rest to ${UPSTREAM}`);
