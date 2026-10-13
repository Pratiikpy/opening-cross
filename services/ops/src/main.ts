// The operations console service. Environment:
//   DATABASE_URL        Postgres (the indexer's migrations create the tables)
//   OPS_TOKENS          JSON list [{ "name", "role": "viewer|reviewer|admin", "sha256": "<hex of the token>" }]; with none, every request is refused
//   OPS_API_URL         base URL of the public API, where evidence is gathered from (optional)
//   OPS_WEBHOOK_SECRET  the secret in the monitor webhook's path /v1/ops/hooks/monitor/<secret> (optional; without it the webhook is off)
//   OPS_KEYPAIR         path to a keypair file that signs the audit-log head (optional; it signs documents only and holds no funds)
//   OPS_PORT, OPS_HOST  default 8792, 127.0.0.1
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { keyPairFromSolanaFile } from '@opening-cross/attest';
import { migrate } from '@opening-cross/indexer';
import { parseTokens } from './auth.js';
import { apiEvidence } from './evidence.js';
import { registerOps } from './routes.js';

const env = process.env;
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const tokens = parseTokens(env.OPS_TOKENS);
const db = new pg.Pool({ connectionString: env.DATABASE_URL });
await migrate(db);
const app = Fastify({ trustProxy: true });
registerOps(app, { db }, {
  tokens,
  ...(env.OPS_API_URL ? { evidence: apiEvidence(env.OPS_API_URL) } : {}),
  signer: env.OPS_KEYPAIR ? await keyPairFromSolanaFile(readFileSync(env.OPS_KEYPAIR, 'utf8')) : null,
  ...(env.OPS_WEBHOOK_SECRET ? { webhookSecret: env.OPS_WEBHOOK_SECRET } : {}),
});
const port = Number(env.OPS_PORT ?? 8792);
await app.listen({ port, host: env.OPS_HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'opening-cross ops console', port, tokens: tokens.length, evidence: Boolean(env.OPS_API_URL), webhook: Boolean(env.OPS_WEBHOOK_SECRET), signedHead: Boolean(env.OPS_KEYPAIR) }));
