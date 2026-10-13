// Holder labelling and funding clusters on a real mainnet token, read-only. With no argument it takes the token traded in the most
// recent successful Meteora Dynamic Bonding Curve transaction, so the pool's own accounts should come out labelled as protocol.
//
//   pnpm exec tsx scripts/mainnet-holders.ts [mint] [endpoint ...]
import { FailoverRpc } from '../../reliability/src/index.js';
import { MemoryFundingCache, clusterByFunding, readHolders, traceFunding } from '../src/index.js';

const [mintArg, ...endpoints] = process.argv.slice(2);
const rpc = new FailoverRpc(endpoints.length ? endpoints : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], { rounds: 4 });
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const WSOL = 'So11111111111111111111111111111111111111112';

let mint = mintArg;
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

const cache = new MemoryFundingCache();
const wallets = report.holders.filter((h) => h.label.kind === 'wallet').slice(0, 8).map((h) => h.owner);
const fundings = [];
for (const w of wallets) {
  const f = await traceFunding(rpc, w, { cache });
  fundings.push(f);
  console.log('funding', w, '<-', f.funder ?? `unknown (${f.unknown})`);
}
const r = clusterByFunding(fundings, { fanout: cache.fanout() });
console.log(JSON.stringify({ clusters: r.clusters.map((c) => ({ members: c.members.length, links: c.links.map((l) => l.why) })), alone: r.alone.length, unknownFunder: r.unknownFunder.length }, null, 1));
