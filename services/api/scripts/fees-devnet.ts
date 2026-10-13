// The fee ledger against real devnet data. The indexer's ingestion path reads every transaction that touched one finished cross into
// a scratch Postgres; the route then compares, for that cross, the cross account's counters, the CrossFinalized event and the token
// balance changes of the finalize transaction as the cluster reports them.
//   DATABASE_URL=postgres://... CROSS=<address> tsx scripts/fees-devnet.ts
import Fastify from 'fastify';
import pg from 'pg';
import { createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { createIndexerRpc, migrate, pollOnce } from '@opening-cross/indexer';
import { registerFees } from '../src/routes/fees.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CROSS = process.env.CROSS ?? 'DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T';
process.env.RPC_URL = RPC;
const rpc = createSolanaRpc(RPC);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
for (const t of ['events', 'orders', 'crosses', 'cursors']) await db.query(`DELETE FROM ${t}`);
const applied = await pollOnce(db, createIndexerRpc(RPC), CROSS as never, `fees-run:${CROSS}`);
console.log(JSON.stringify({ step: 'ingested from devnet', cross: CROSS, events: applied }));

const app = Fastify();
registerFees(app, {
  db,
  network: 'devnet',
  account: async (a) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
});
await app.ready();
const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
console.log(JSON.stringify({ step: 'schedule', ...(await get('/v1/fees/schedule')) }, null, 1));
console.log(JSON.stringify({ step: 'ledger', ...(await get('/v1/fees/ledger')) }, null, 1));
await app.close();
await db.end();
