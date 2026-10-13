// The dashboard over real data: every section's source route is forwarded to the deployed API, and the programs are read from devnet.
//   tsx scripts/dashboard-devnet.ts [apiBase]
import Fastify from 'fastify';
import { createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { registerDashboard } from '../src/routes/dashboard.js';

const API = (process.argv[2] ?? 'https://98-87-59-136.sslip.io').replace(/\/$/, '');
const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.devnet.solana.com');
const app = Fastify();
for (const path of ['/v1/health', '/v1/stats', '/v1/metrics/execution', '/v1/metrics/fairness', '/v1/metrics/external-flow', '/v1/accuracy', '/v1/fees/ledger', '/v1/fees/schedule']) {
  app.get(path, async (req, reply) => {
    const res = await fetch(API + req.url, { signal: AbortSignal.timeout(30_000) });
    return reply.code(res.status).type('application/json').send(await res.text());
  });
}
registerDashboard(app, {
  network: 'devnet',
  account: async (a) => {
    for (let i = 0; i < 4; i++) {
      try {
        const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
        return x.exists ? { data: x.data, owner: x.programAddress } : null;
      } catch (e) {
        if (i === 3) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    return null;
  },
});
await app.ready();
const body = (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
for (const [name, s] of Object.entries(body.sections as Record<string, { ok: boolean; source: string; data?: unknown; error?: string }>)) {
  console.log(`--- ${name} (${s.source}) ${s.ok ? 'ok' : 'UNAVAILABLE: ' + s.error}`);
  if (s.ok) console.log(JSON.stringify(s.data).slice(0, 700));
}
await app.close();
