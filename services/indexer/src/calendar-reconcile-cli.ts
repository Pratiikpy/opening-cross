// One-shot reconciliation of the calendar index: compares every indexed cross_calendar account with the chain and prints the
// drift as JSON. DATABASE_URL and RPC_URL are required; exits 1 if any drift survives catching up, 0 when the index equals the chain.
//   ATTEMPTS=3 (catch-up rounds)     WAIT_MS=10000 (between rounds)     REPAIR=1 (overwrite differing rows from chain)
import pg from 'pg';
import { pollCalendar, reconcileCalendars, scanCalendars } from './calendar.js';
import { createIndexerRpc } from './rpc.js';

const { DATABASE_URL, RPC_URL } = process.env;
if (!DATABASE_URL || !RPC_URL) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DATABASE_URL });
const rpc = createIndexerRpc(RPC_URL);
const { rows } = await db.query('SELECT count(*)::int AS calendars FROM calendars');
const drift = await reconcileCalendars(db, () => scanCalendars(rpc), {
  catchUp: () => pollCalendar(db, rpc),
  attempts: Number(process.env.ATTEMPTS ?? 3),
  waitMs: Number(process.env.WAIT_MS ?? 10_000),
  repair: process.env.REPAIR === '1',
});
const { calendars: onchain } = await scanCalendars(rpc);
console.log(JSON.stringify({ at: new Date().toISOString(), calendarsIndexed: rows[0].calendars, calendarsOnChain: onchain.length, driftCount: drift.length, drift }, null, 2));
await db.end();
process.exit(drift.length === 0 ? 0 : 1);
