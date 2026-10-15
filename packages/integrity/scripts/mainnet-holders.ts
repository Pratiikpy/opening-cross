// Holder labelling and funding clusters on a real mainnet token, read-only, as a job that finishes (F3, F8). With no mint it takes the token traded in the most recent successful
// Meteora Dynamic Bonding Curve transaction, so the pool's own accounts should come out labelled as protocol.
//
//   pnpm exec tsx scripts/mainnet-holders.ts [--mint M] [--cache funding.jsonl] [--interval 1200] [--wallets 12] [--budget 900] [--endpoint URL ...]
//
//   --cache      file where every funding found is appended; a run that is stopped or refused resumes from it and repeats no call (default: the system temp directory)
//   --interval   least milliseconds between RPC calls (default 1200, which the public mainnet endpoints tolerate; a paid endpoint can take 50)
//   --wallets    how many wallet holders to trace, largest first (default 12)
//   --budget     seconds after which no new wallet is started (default 900); run again to continue
//   --max-pages  pages of 1000 signatures read looking for the start of a wallet's history (default 3). A busy wallet needs more: raise it to trace one with a long history
//   --ascending  read each wallet's oldest transactions with Helius's getTransactionsForAddress in one call (needs a Helius endpoint; not verified live), paging if it is refused
//   --endpoint   RPC URL, repeatable; a paid endpoint first, the public ones after (default: two public endpoints)
//
// The run states what it did not finish. Exit code 0 means every wallet asked for was traced; 3 means some are still untraced and a second run continues.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailoverRpc } from '../../reliability/src/index.js';
import { FileFundingCache, clusterByFunding, fundingBursts, pacedRpc, readHolders, traceWallets } from '../src/index.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]!] : []));
const endpoints = all('endpoint');
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const WSOL = 'So11111111111111111111111111111111111111112';

const rpc = pacedRpc(new FailoverRpc(endpoints.length ? endpoints : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], { rounds: 3 }), {
  minIntervalMs: Number(opt('interval', '1200')),
  retries: 8,
  onRetry: (r) => console.error(`  wait ${r.waitMs} ms (${r.method}, attempt ${r.attempt}): ${r.reason}`),
});

let mint = opt('mint');
if (!mint) {
  const sigs = await rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [DBC, { limit: 25 }]);
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await rpc.call<{ meta: { postTokenBalances: { mint: string }[] } } | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
    const m = tx?.meta.postTokenBalances.map((b) => b.mint).find((x) => x !== WSOL);
    if (m) {
      mint = m;
      console.log('token from DBC transaction', s.signature);
      break;
    }
  }
}
if (!mint) throw new Error('no token found');
console.log('mint', mint);

const report = await readHolders(rpc, mint);
console.log(JSON.stringify({ supply: String(report.supply), coveredBps: report.coveredBps, byKind: report.byKind }, null, 1));
for (const h of report.holders) console.log(String(h.shareBps / 100).padStart(6) + '%', h.label.kind.padEnd(16), h.owner, '-', h.label.name);

const cachePath = opt('cache', join(tmpdir(), `oc-funding-${mint}.jsonl`))!;
const cache = new FileFundingCache(cachePath);
const wallets = report.holders.filter((h) => h.label.kind === 'wallet').slice(0, Number(opt('wallets', '12'))).map((h) => h.owner);
console.log(`tracing ${wallets.length} wallets; cache ${cachePath}`);
const t0 = Date.now();
const job = await traceWallets(rpc, wallets, {
  cache,
  concurrency: 2,
  maxPages: Number(opt('max-pages', '3')),
  ascending: args.includes('--ascending'),
  budgetMs: Number(opt('budget', '900')) * 1000,
  onProgress: (p) => console.log(`  ${p.done}/${p.total} ${p.outcome} ${p.wallet}`),
});
for (const [w, f] of job.fundings) console.log('funding', w, '<-', f.funder ?? `unknown (${f.unknown})`, f.lamports !== null ? `${f.lamports} lamports` : '');
const holdings = new Map(report.holders.map((h) => [h.owner, h.shareBps]));
const r = clusterByFunding([...job.fundings.values()], { fanout: cache.fanout(), holdings });
console.log(
  JSON.stringify(
    {
      seconds: Math.round((Date.now() - t0) / 1000),
      traced: job.fundings.size,
      withFunder: job.funded,
      historyUnknown: job.unknownHistory,
      fromCache: job.fromCache,
      untraced: job.untraced,
      clusters: r.clusters.map((c) => ({ members: c.members.length, shareBps: c.shareBps, links: c.links.map((l) => l.why) })),
      fundingBursts: fundingBursts([...job.fundings.values()]).map((b) => ({ wallets: b.wallets.length, funders: b.funders.length, lamports: String(b.lamports), spanSecs: b.spanSecs })),
      alone: r.alone.length,
      unknownFunder: r.unknownFunder.length,
      ignoredServices: r.ignoredServices,
    },
    null,
    1,
  ),
);
process.exit(job.complete ? 0 : 3);
