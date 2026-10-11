// One live measurement round over mainnet, printed as a table and written to a JSON file.
//   RPC_URL      mainnet RPC (default: public)
//   TICKERS      comma list to restrict the round (default: every routable candidate)
//   SIZES        comma list of USD sizes (default 100,1000,10000)
//   OUT          output file (default measure-<time>.json)
import { writeFileSync } from 'node:fs';
import { createSolanaRpc } from '@solana/kit';
import { loadBundledBook } from '@opening-cross/authenticity';
import { candidates, collectRound, fetchHip3, fetchIssuerStates, groupObservations, jupiterQuoter, percentText, readMintFacts, routable } from '../src/index.js';
import type { MeasuredAsset } from '../src/index.js';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com');
const sizes = (process.env.SIZES ?? '100,1000,10000').split(',').map(Number);
const only = process.env.TICKERS?.split(',').map((t) => t.trim().toUpperCase());
const quote = jupiterQuoter();
const now = Math.floor(Date.now() / 1000);

const [refs, states] = [await fetchHip3(), await fetchIssuerStates()];
const oracle = refs.filter((r) => r.kind === 'hip3_oracle');
let list = candidates(loadBundledBook(), oracle);
if (only) list = list.filter((e) => only.includes(e.ticker));
console.error(`${list.length} candidates with a reference; probing routes`);
const { kept, dropped } = await routable(quote, list, 200);
console.error(`${kept.length} routable, ${dropped.length} not`);

const facts = await readMintFacts(rpc, kept.map((e) => e.mint), BigInt(now));
const assets: MeasuredAsset[] = kept.map((e) => ({ ...e, decimals: facts.get(e.mint)?.decimals ?? 0, multiplierE12: facts.get(e.mint)?.multiplierE12 ?? null }));
const obs = await collectRound(assets, {
  quote,
  now,
  sizesUsd: sizes,
  referenceKind: 'hip3_oracle',
  references: new Map(oracle.map((r) => [r.ticker, r])),
  issuer: new Map(states.map((s) => [s.ticker, s])),
  paceMs: 250,
});

for (const g of groupObservations(obs)) {
  const s = g.summary;
  console.log(`${g.session.padEnd(9)} ${String(g.sizeUsd).padStart(6)} ${g.leg.padEnd(4)} n=${String(s.n).padStart(3)} median ${s.medianBpsX100 === null ? '—' : percentText(s.medianBpsX100)} p10 ${s.p10BpsX100 === null ? '—' : percentText(s.p10BpsX100)} p90 ${s.p90BpsX100 === null ? '—' : percentText(s.p90BpsX100)} excluded ${JSON.stringify(g.excluded)}`);
}
const out = process.env.OUT ?? `measure-${now}.json`;
writeFileSync(out, JSON.stringify({ at: now, sizes, dropped: dropped.map((d) => ({ ticker: d.entry.ticker, reason: d.reason })), observations: obs }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
console.error(`wrote ${out}`);
