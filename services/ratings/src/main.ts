// The ratings service, one command per job (run each on a schedule; every one is safe to repeat):
//
//   collect                 poll the launch feed once and record new launches (every few minutes)
//   watch [secs=20]        collect every `secs` seconds and resolve due launches (1 and 7 days) every ten minutes, until stopped: one process does both jobs
//   resolve [days=7]        read the outcome of every launch whose horizon has just passed (hourly; a late run records `missed`, not a guess)
//   index [days=7]          print the venture index as JSON
//   survival [days=30]      record whether rated crosses' tokens were alive at the horizon (DATABASE_URL; hourly for a day after each horizon; the label the OVS bar needs)
//   bars-input [dir]        write the observations the release bars are scored on (ratings.json, ovs.json, agents.json) from the database and the survival log
//   outcomes                write the outcome of rated crosses whose horizon has passed (DATABASE_URL, RPC_URL; daily)
//
// STATE_DIR holds the launch log (default ./ratings-state). Nothing here signs or sends a transaction.
import { join } from 'node:path';
import pg from 'pg';
import { type Address, fetchEncodedAccount } from '@solana/kit';
import { RATING_VERSION } from '@opening-cross/integrity';
import { GeckoPriceSource } from './price.js';
import { PgRatingStore, resolveOutcomes } from './outcomes.js';
import { readBarsInput, writeBarsInput } from './bars-input.js';
import { SurvivalLog, ratedCrosses, resolveSurvival } from './survival.js';
import { FileLaunchStore, collectOnce, resolveDue, ventureIndex } from './venture.js';

const [cmd, arg] = process.argv.slice(2);
const stateDir = process.env.STATE_DIR ?? './ratings-state';
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1);

if (cmd === 'collect') {
  const store = new FileLaunchStore(join(stateDir, 'launches.jsonl'));
  console.log(json({ at: new Date().toISOString(), ...(await collectOnce(store)), known: store.launches().length }));
} else if (cmd === 'watch') {
  const store = new FileLaunchStore(join(stateDir, 'launches.jsonl'));
  const every = Math.max(5, Number(arg ?? 20)) * 1000;
  let lastResolve = 0;
  for (;;) {
    try {
      console.log(json({ at: new Date().toISOString(), collected: await collectOnce(store), known: store.launches().length }));
      if (Date.now() - lastResolve > 600_000) {
        lastResolve = Date.now();
        for (const days of [1, 7]) console.log(json({ at: new Date().toISOString(), horizonDays: days, ...(await resolveDue(store, days)) }));
      }
    } catch (e) {
      console.error(json({ at: new Date().toISOString(), error: String(e) }));
    }
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === 'resolve') {
  const store = new FileLaunchStore(join(stateDir, 'launches.jsonl'));
  console.log(json({ at: new Date().toISOString(), horizonDays: Number(arg ?? 7), ...(await resolveDue(store, Number(arg ?? 7))) }));
} else if (cmd === 'index') {
  const store = new FileLaunchStore(join(stateDir, 'launches.jsonl'));
  console.log(json(ventureIndex(store, Number(arg ?? 7), Math.floor(Date.now() / 1000))));
} else if (cmd === 'survival') {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required for survival');
    process.exit(2);
  }
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const days = Number(arg ?? 30);
  const log = new SurvivalLog(join(stateDir, 'survival.jsonl'));
  const crosses = await ratedCrosses(db, RATING_VERSION, Math.floor(Date.now() / 1000) - days * 86_400, 200);
  console.log(json({ at: new Date().toISOString(), horizonDays: days, rated: crosses.length, ...(await resolveSurvival(crosses, log, days)) }));
  await db.end();
} else if (cmd === 'bars-input') {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required for bars-input');
    process.exit(2);
  }
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const dir = arg ?? stateDir;
  const input = await readBarsInput(db, RATING_VERSION, new SurvivalLog(join(stateDir, 'survival.jsonl')));
  writeBarsInput(dir, input);
  console.log(json({ dir, ratings: input.ratings.length, ovs: input.ovs.length, agents: input.agents.length, excluded: input.excluded }));
  await db.end();
} else if (cmd === 'outcomes') {
  const { DATABASE_URL, RPC_URL } = process.env;
  if (!DATABASE_URL || !RPC_URL) {
    console.error('DATABASE_URL and RPC_URL are required for outcomes');
    process.exit(2);
  }
  const { createSolanaRpc } = await import('@solana/kit');
  const rpc = createSolanaRpc(RPC_URL);
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const account = async (a: Address) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  };
  const results = await resolveOutcomes({ store: new PgRatingStore(db), prices: new GeckoPriceSource(), account, now: () => Math.floor(Date.now() / 1000), version: RATING_VERSION });
  console.log(json({ at: new Date().toISOString(), results }));
  await db.end();
} else {
  console.error('usage: main.ts collect | watch [secs] | resolve [days] | index [days] | survival [days] | bars-input [dir] | outcomes');
  process.exit(2);
}
