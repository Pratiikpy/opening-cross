// The billing service. Environment:
//   DATABASE_URL     Postgres (the indexer's migrations create the tables)
//   RPC_URL          JSON-RPC endpoint; a comma separated list is used in order with failover
//   BILLING_MINT     the token subscriptions are paid in
//   REVENUE_WALLET   the wallet that receives them
//   BILLING_KEYPAIR  path to a keypair file that signs invoices (it signs documents only; it holds no funds)
//   BILLING_PORT     default 8791        BILLING_HOST   default 127.0.0.1
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { keyPairFromSolanaFile } from '@opening-cross/attest';
import { migrate } from '@opening-cross/indexer';
import { jsonRpcChain } from './rpc.js';
import { registerBilling } from './routes.js';

const env = process.env;
const need = (n: string): string => {
  const v = env[n];
  if (!v) {
    console.error(`${n} is required`);
    process.exit(2);
  }
  return v;
};
const db = new pg.Pool({ connectionString: need('DATABASE_URL') });
await migrate(db);
const app = Fastify({ trustProxy: true });
registerBilling(app, { db }, {
  mint: need('BILLING_MINT'),
  revenueWallet: need('REVENUE_WALLET'),
  chain: jsonRpcChain(need('RPC_URL').split(',')),
  signer: env.BILLING_KEYPAIR ? await keyPairFromSolanaFile(readFileSync(env.BILLING_KEYPAIR, 'utf8')) : null,
});
const port = Number(env.BILLING_PORT ?? 8791);
await app.listen({ port, host: env.BILLING_HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'opening-cross billing', port, invoices: env.BILLING_KEYPAIR ? 'signed' : 'disabled (no BILLING_KEYPAIR)' }));
