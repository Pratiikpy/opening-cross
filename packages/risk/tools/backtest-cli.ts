// Runs the walk-forward backtest over the cached history and writes the derived results to data/ (statistics only, no prices).
//
//   pnpm --filter @opening-cross/risk history      # once, to download
//   pnpm --filter @opening-cross/risk backtest
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Bar, DEFAULT_POLICY, type LtvPolicy, backtest, closureForHours, engineEvents, gapsOf, maxLtv, statsOf, summarise, summariseOutcomes } from '../src/index.js';
import { UNIVERSE, fetchBars } from './fetch-history.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const series: Record<string, Bar[]> = {};
for (const t of UNIVERSE) series[t] = await fetchBars(t, '10y');

const report = backtest(series, DEFAULT_POLICY, 100);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
console.log(`Walk-forward over ${report.assets} assets, weekend and holiday-weekend closures, ${DEFAULT_POLICY.liquidationBonusBps} bps liquidation discount, LTV set from earlier history only.\n`);
console.log('policy'.padEnd(34), 'events'.padStart(7), 'bad debt'.padStart(9), 'rate'.padStart(8), 'mean LTV'.padStart(9), 'loss/debt'.padStart(10), 'worst'.padStart(8), 'certified'.padStart(10));
for (const o of report.perPolicy) console.log(o.policy.padEnd(34), String(o.events).padStart(7), String(o.badDebt).padStart(9), pct(o.badDebtRate).padStart(8), `${(o.meanLtvBps / 100).toFixed(1)}%`.padStart(9), `${(o.lossOfDebtBps / 100).toFixed(3)}%`.padStart(10), `${(o.worstLossOfDebtBps / 100).toFixed(1)}%`.padStart(8), pct(o.certifiedShare).padStart(10));

// Where does the MODEL, not the policy's cap and floor, set the LTV? Rerun with the cap at 95% and no minimum assumed loss or buffer,
// restricted to events where the history certifies the bound. The certified guarantee is a probability per closure: P(bad debt) <= alpha
// (1% for weekends) at 95% confidence, so the observed rate should sit below 1%; if it does not, the method is wrong.
const modelOnly: LtvPolicy = { ...DEFAULT_POLICY, capBps: 9_500, minLossBps: 0, bufferBps: 0 };
const modelEvents = Object.entries(series).flatMap(([t, bars]) => engineEvents(t, gapsOf(bars), modelOnly, 100)).filter((e) => e.certified);
const model = summariseOutcomes('model only, certified events', modelEvents, modelOnly.liquidationBonusBps);
const same = [80, 90].map((f) => summariseOutcomes(`fixed ${f}% on the same events`, modelEvents.map((e) => ({ ...e, ltvBps: f * 100 })), modelOnly.liquidationBonusBps));
console.log('\nModel-driven LTV (cap 95%, no assumed minimum loss, no buffer), certified events only:');
for (const o of [model, ...same]) console.log(o.policy.padEnd(34), String(o.events).padStart(7), String(o.badDebt).padStart(9), pct(o.badDebtRate).padStart(8), `${(o.meanLtvBps / 100).toFixed(1)}%`.padStart(9), `${(o.lossOfDebtBps / 100).toFixed(3)}%`.padStart(10), `${(o.worstLossOfDebtBps / 100).toFixed(1)}%`.padStart(8));
const certifiedOnly = Object.entries(series).flatMap(([t, bars]) => engineEvents(t, gapsOf(bars), DEFAULT_POLICY, 100)).filter((e) => e.certified);
const certDefault = [summariseOutcomes('default policy, certified events', certifiedOnly, DEFAULT_POLICY.liquidationBonusBps), ...[7_000, 8_000].map((f) => summariseOutcomes(`fixed ${f / 100}% on the same events`, certifiedOnly.map((e) => ({ ...e, ltvBps: f })), DEFAULT_POLICY.liquidationBonusBps))];
console.log('\nDefault policy, certified events only:');
for (const o of certDefault) console.log(o.policy.padEnd(34), String(o.events).padStart(7), String(o.badDebt).padStart(9), pct(o.badDebtRate).padStart(8), `${(o.meanLtvBps / 100).toFixed(1)}%`.padStart(9), `${(o.lossOfDebtBps / 100).toFixed(3)}%`.padStart(10), `${(o.worstLossOfDebtBps / 100).toFixed(1)}%`.padStart(8));

// The LTV the engine would set today for each asset, from its full history, with the evidence it rests on.
const today = Object.entries(series).map(([ticker, bars]) => {
  const gaps = gapsOf(bars);
  const stats = (c: 'overnight' | 'weekend' | 'long') => statsOf(gaps, c);
  const weekend = maxLtv(stats('weekend'), DEFAULT_POLICY);
  const overnight = maxLtv(stats('overnight'), DEFAULT_POLICY);
  const long = maxLtv(stats('long'), DEFAULT_POLICY);
  return { ticker, closure: closureForHours(72), ltvBps: Math.min(weekend.ltvBps, overnight.ltvBps), weekend, overnight, long, summaries: { overnight: summarise(stats('overnight')), weekend: summarise(stats('weekend')), long: summarise(stats('long')) } };
});
console.log('\nLTV for a weekend closure today (the lower of the overnight and weekend limits):');
for (const t of today) console.log(t.ticker.padEnd(6), `${(t.ltvBps / 100).toFixed(1)}%`.padStart(7), t.weekend.certified && t.overnight.certified ? 'certified' : 'NOT certified', `| weekend: ${t.weekend.basis}`);

const out = {
  schema: 'opening-cross/risk/backtest/v1',
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'Yahoo Finance public chart endpoint, daily bars, 10 years to 2026-10-12 (derived statistics only; prices are not redistributed)',
  policy: DEFAULT_POLICY,
  minHistory: report.minHistory,
  perPolicy: report.perPolicy,
  perAsset: report.perAsset,
  certifiedOnlyDefaultPolicy: certDefault,
  modelOnlyCertified: [model, ...same],
  ltvToday: today.map((t) => ({ ticker: t.ticker, weekendLtvBps: t.ltvBps, certified: t.weekend.certified && t.overnight.certified, weekend: { n: t.weekend.n, rank: t.weekend.rank, coveredLossBps: t.weekend.coveredLossBps }, overnight: { n: t.overnight.n, rank: t.overnight.rank, coveredLossBps: t.overnight.coveredLossBps } })),
  gapSummaries: Object.fromEntries(today.map((t) => [t.ticker, t.summaries])),
};
writeFileSync(join(dir, 'backtest-2026-10-12.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nwrote data/backtest-2026-10-12.json`);
