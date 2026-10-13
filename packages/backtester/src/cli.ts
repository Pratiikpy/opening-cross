#!/usr/bin/env node
// opening-cross-backtest --api <url> --strategy passive-buy|market-maker|last-second-bid [--param key=value]... [--limit 1000] [--cache file.json] [--json]
// --cache keeps the responses for finalized crosses (they never change) so a second run reads nothing from the API.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { STRATEGIES } from './strategies.js';
import { backtest, formatReport, toJson } from './backtest.js';
import { loadFromApi } from './history.js';

const args = process.argv.slice(2);
const one = (n: string) => args[args.indexOf(`--${n}`) + 1];
const has = (n: string) => args.includes(`--${n}`);
const api = one('api') ?? process.env.OPENING_CROSS_API;
const name = one('strategy');
if (!api || !name || !STRATEGIES[name]) {
  console.error(`usage: opening-cross-backtest --api <url> --strategy ${Object.keys(STRATEGIES).join('|')} [--param key=value]... [--limit n] [--json]`);
  process.exit(2);
}
const params: Record<string, string> = {};
args.forEach((a, i) => {
  if (a === '--param' && args[i + 1]?.includes('=')) {
    const [k, ...v] = args[i + 1]!.split('=');
    params[k!] = v.join('=');
  }
});
const history = await loadFromApi(api, { ...(one('limit') ? { limit: Number(one('limit')) } : {}), onProgress: (d, t) => process.stderr.write(`\rreading ${d}/${t}`) });
process.stderr.write('\n');
const result = backtest(history.crosses, STRATEGIES[name]!(params));
console.log(has('json') ? toJson(result) : formatReport(result, history.skipped.length));
if (!has('json') && history.skipped.length) {
  const why = new Map<string, number>();
  for (const s of history.skipped) why.set(s.reason.replace(/^could not be read: .*/, 'could not be read'), (why.get(s.reason) ?? 0) + 1);
  console.log(`\nNot replayed: ${[...why.entries()].map(([r, n]) => `${n} (${r})`).join('; ')}`);
}
