// Indexer process: DATABASE_URL and RPC_URL from the environment; polls every POLL_MS and
// reconciles every RECONCILE_EVERY polls.
import { type Address, fetchEncodedAccount, fetchEncodedAccounts } from '@solana/kit';
import pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { bindCrosses, pollCalendar, reconcileCalendars, rpcAccountReader, scanCalendars } from './calendar.js';
import { createIndexerRpc } from './rpc.js';
import { migrate } from './ingest.js';
import { backfillOrderTerms } from './order-terms.js';
import { pollOnce } from './rpc-source.js';
import { type AccountFetcher, reconcileSettled } from './reconcile.js';
import { PROGRAM_NAMES, type ProgramName, pollProgramsOnce } from './programs.js';
import { pollSettleOnce } from './settle.js';
import { pollTreasuryOnce } from './treasury.js';

const dbUrl = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL;
if (!dbUrl || !rpcUrl) {
  console.error('DATABASE_URL and RPC_URL are required');
  process.exit(2);
}
const pollMs = Number(process.env.POLL_MS ?? 5_000);
const reconcileEvery = Number(process.env.RECONCILE_EVERY ?? 60);
const slowEvery = Math.max(1, Number(process.env.SLOW_EVERY ?? 4));
// cross_settle programs to follow (a comma-separated list of addresses; the devnet Raydium variant is a second program with the same events).
const settlePrograms = (process.env.SETTLE_PROGRAMS ?? CROSS_SETTLE_PROGRAM_ADDRESS).split(',').map((a) => a.trim()).filter(Boolean) as Address[];

// The seven Wave 3D programs to follow (a comma-separated list of names such as cross_mandate; default all of them, `none` turns them off). A program the cluster does not have costs one
// empty signature query per slow tick and changes nothing.
const wave3dText = (process.env.WAVE3D_PROGRAMS ?? 'all').trim();
const wave3dPrograms: ProgramName[] = wave3dText === 'all' ? PROGRAM_NAMES : wave3dText === 'none' || wave3dText === '' ? [] : wave3dText.split(',').map((n) => n.trim()).filter(Boolean).map((n) => {
  if (!(PROGRAM_NAMES as string[]).includes(n)) throw new Error(`unknown WAVE3D_PROGRAMS entry "${n}"; the programs are ${PROGRAM_NAMES.join(', ')}, or all, none`);
  return n as ProgramName;
});

const db = new pg.Pool({ connectionString: dbUrl });
const rpc = createIndexerRpc(rpcUrl);
const readAccounts = rpcAccountReader(rpc);
const fetcher: AccountFetcher = Object.assign(
  async (a: Address) => {
    const acct = await fetchEncodedAccount(rpc, a, { commitment: 'finalized' });
    return acct.exists ? acct.data : null;
  },
  {
    many: async (addresses: Address[]) => {
      const out: (Uint8Array | null)[] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const found = await fetchEncodedAccounts(rpc, addresses.slice(i, i + 100), { commitment: 'finalized' });
        out.push(...found.map((x) => (x.exists ? x.data : null)));
      }
      return out;
    },
  },
);

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
    // Calendars, their cross bindings and treasuries change slowly and share the public endpoint's per-address limit with every
    // other process: they are read every SLOW_EVERY polls (default 4), the core program on every one.
    if (tick % slowEvery === 0) {
      // cross_calendar: calendars and their events, then the calendar each newly indexed cross is bound to.
      const cal = await pollCalendar(db, rpc, readAccounts);
      if (cal) console.log(JSON.stringify({ at: new Date().toISOString(), calendarEventsApplied: cal }));
      const bound = await bindCrosses(db, readAccounts, CROSS_CORE_PROGRAM_ADDRESS);
      if (bound.bound) console.log(JSON.stringify({ at: new Date().toISOString(), crossBindingsRead: bound.bound, remaining: bound.remaining }));
      const tre = await pollTreasuryOnce(db, rpc);
      if (tre) console.log(JSON.stringify({ at: new Date().toISOString(), treasuryEventsApplied: tre }));
      const wave3d = await pollProgramsOnce(db, rpc, wave3dPrograms);
      if (wave3d) console.log(JSON.stringify({ at: new Date().toISOString(), wave3dEventsApplied: wave3d }));
      for (const program of settlePrograms) {
        const settled = await pollSettleOnce(db, rpc, program);
        if (settled) console.log(JSON.stringify({ at: new Date().toISOString(), settleEventsApplied: settled, program }));
      }
    }
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
