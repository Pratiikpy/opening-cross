// Indexer process: DATABASE_URL and RPC_URL from the environment; polls every POLL_MS and
// reconciles every RECONCILE_EVERY polls.
import { type Address, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { bindCrosses, pollCalendar, reconcileCalendars, rpcAccountReader, scanCalendars } from './calendar.js';
import { createIndexerRpc } from './rpc.js';
import { migrate } from './ingest.js';
import { backfillOrderTerms } from './order-terms.js';
import { pollOnce } from './rpc-source.js';
import { reconcileSettled } from './reconcile.js';
import { pollTreasuryOnce } from './treasury.js';

const dbUrl = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL;
if (!dbUrl || !rpcUrl) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const pollMs = Number(process.env.POLL_MS ?? 5_000);
const reconcileEvery = Number(process.env.RECONCILE_EVERY ?? 60);

const db = new pg.Pool({ connectionString: dbUrl });
const rpc = createIndexerRpc(rpcUrl);
const readAccounts = rpcAccountReader(rpc);
const fetcher = async (a: Address) => {
  const acct = await fetchEncodedAccount(rpc, a, { commitment: 'finalized' });
  return acct.exists ? acct.data : null;
};

await migrate(db);
for (let tick = 0; ; tick++) {
  try {
    const head = await rpc.getSlot({ commitment: 'finalized' }).send();
    const n = await pollOnce(db, rpc);
    // Written only after a poll that finished, so a long backfill or a stuck RPC shows up as an old heartbeat.
    await db.query('INSERT INTO indexer_heartbeat (id, head_slot, polled_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET head_slot = EXCLUDED.head_slot, polled_at = EXCLUDED.polled_at', [head.toString()]);
    if (n) console.log(JSON.stringify({ at: new Date().toISOString(), applied: n }));
    // Open orders indexed before their terms were captured are filled in a few at a time.
    const filled = await backfillOrderTerms(db, rpc);
    if (filled.updated) console.log(JSON.stringify({ at: new Date().toISOString(), orderTermsBackfilled: filled.updated, remaining: filled.remaining }));
    // cross_calendar: calendars and their events, then the calendar each newly indexed cross is bound to.
    const cal = await pollCalendar(db, rpc, readAccounts);
    if (cal) console.log(JSON.stringify({ at: new Date().toISOString(), calendarEventsApplied: cal }));
    const bound = await bindCrosses(db, readAccounts, CROSS_CORE_PROGRAM_ADDRESS);
    if (bound.bound) console.log(JSON.stringify({ at: new Date().toISOString(), crossBindingsRead: bound.bound, remaining: bound.remaining }));
    const tre = await pollTreasuryOnce(db, rpc);
    if (tre) console.log(JSON.stringify({ at: new Date().toISOString(), treasuryEventsApplied: tre }));
    if (tick % reconcileEvery === 0) {
      const calDrift = await reconcileCalendars(db, () => scanCalendars(rpc), { catchUp: () => pollCalendar(db, rpc, readAccounts), waitMs: pollMs, attempts: 5, record: true, repair: true });
      if (calDrift.length) console.error(JSON.stringify({ at: new Date().toISOString(), calendarDrift: calDrift }));
      const drift = await reconcileSettled(db, fetcher, () => pollOnce(db, rpc), { record: true, waitMs: pollMs, attempts: 5 });
      if (drift.length) console.error(JSON.stringify({ at: new Date().toISOString(), drift }));
    }
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
