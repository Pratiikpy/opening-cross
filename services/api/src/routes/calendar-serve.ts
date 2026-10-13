// The API with the calendar routes registered, for runs where server.ts does not register them yet (the devnet proof
// tests/devnet/src/calendar-live-proof.ts starts it this way). Same environment as main.ts: DATABASE_URL, RPC_URL, PORT, HOST, NETWORK.
// Once server.ts calls registerCalendar itself, main.ts serves the same routes and this entry is not needed.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc, migrate } from '@opening-cross/indexer';
import { buildServer } from '../server.js';
import { registerCalendar } from './calendar.js';

const { DATABASE_URL, RPC_URL } = process.env;
if (!DATABASE_URL || !RPC_URL) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DATABASE_URL });
const rpc = createIndexerRpc(RPC_URL);
await migrate(db);
const account = async (a: Address) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
      return x.exists ? { data: x.data, owner: x.programAddress } : null;
    } catch (e) {
      const busy = /429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {})}`);
      if (!busy || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
};
const deps = {
  db,
  network: process.env.NETWORK ?? 'devnet',
  account,
  lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value,
};
const app = await buildServer(deps);
if (!app.hasRoute({ method: 'GET', url: '/v1/calendar' })) registerCalendar(app, deps);
const where = await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ at: new Date().toISOString(), listening: where }));
