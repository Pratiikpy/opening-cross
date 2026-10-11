// Premium monitor process.
//   DATABASE_URL            required
//   RPC_URL                 required, a Solana MAINNET endpoint (the monitor measures mainnet liquidity)
//   NETWORK                 required, must be mainnet-beta: there is no stock-token liquidity to measure elsewhere
//   ROUND_MS (300000)       time between rounds
//   UNIVERSE_MS (21600000)  time between rebuilds of the measured universe
//   SIZES (100,1000,10000)  order sizes in USD
//   PACE_MS (250)           pause between quotes, to stay inside the quote API's rate limit
//   TICKERS                 optional comma list that restricts the universe (default: every routable candidate)
import { createSolanaRpc } from '@solana/kit';
import { loadBundledBook } from '@opening-cross/authenticity';
import { fetchHip3, fetchIssuerStates, jupiterQuoter, readMintFacts } from '@opening-cross/premium';
import pg from 'pg';
import { insertObservations } from './store.js';
import { type RoundDeps, type Universe, buildUniverse, measureRound } from './round.js';

const { DATABASE_URL, RPC_URL, NETWORK } = process.env;
if (!DATABASE_URL || !RPC_URL || NETWORK !== 'mainnet-beta') {
  console.error('DATABASE_URL and RPC_URL are required, and NETWORK must be mainnet-beta');
  process.exit(2);
}
const roundMs = Number(process.env.ROUND_MS ?? 300_000);
const universeMs = Number(process.env.UNIVERSE_MS ?? 21_600_000);
const rpc = createSolanaRpc(RPC_URL);
const db = new pg.Pool({ connectionString: DATABASE_URL });
const deps: RoundDeps = {
  book: loadBundledBook(),
  quote: jupiterQuoter(),
  fetchReferences: () => fetchHip3(),
  fetchIssuer: () => fetchIssuerStates(),
  readFacts: (mints, now) => readMintFacts(rpc, mints, now),
  now: () => Math.floor(Date.now() / 1000),
  sizesUsd: (process.env.SIZES ?? '100,1000,10000').split(',').map(Number),
  paceMs: Number(process.env.PACE_MS ?? 250),
};

const log = (o: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), ...(o as object) }));
let universe: Universe | null = null;
log({ started: true });
for (;;) {
  try {
    if (!universe || Date.now() / 1000 - universe.builtAt > universeMs / 1000) {
      universe = await buildUniverse(deps, process.env.TICKERS?.split(',').map((t) => t.trim().toUpperCase()));
      log({ universe: universe.entries.length, dropped: universe.dropped.length });
    }
    const obs = await measureRound(deps, universe);
    const stored = await insertObservations(db, NETWORK, obs);
    log({ stored, ok: obs.filter((o) => o.status === 'ok').length });
  } catch (e) {
    log({ error: String(e) });
  }
  await new Promise((r) => setTimeout(r, roundMs));
}
