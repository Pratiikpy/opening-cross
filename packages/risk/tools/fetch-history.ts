// Downloads daily bars for US equities from Yahoo Finance's public chart endpoint and caches them OUTSIDE the repository (the cache
// directory is .tmp/risk-history at the repository root, which is git-ignored). Yahoo's terms do not allow redistributing its data, so
// the repository holds this script and the derived statistics (data/*.json), never the bars.
//
//   pnpm --filter @opening-cross/risk history -- AAPL TSLA NVDA        (default: the universe below)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../src/gaps.js';

export const UNIVERSE = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX', 'AMD', 'JPM', 'COIN', 'HOOD', 'MSTR'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cacheDir = join(root, '.tmp', 'risk-history');

const micro = (x: number) => Math.round(x * 1_000_000);

export async function fetchBars(ticker: string, range = '10y', refresh = false): Promise<Bar[]> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${ticker}-${range}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Bar[];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d&includePrePost=false`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (opening-cross risk research)' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const body = (await res.json()) as { chart: { result?: { timestamp: number[]; meta: { exchangeTimezoneName: string }; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } };
  const r = body.chart.result?.[0];
  if (!r) throw new Error(`${ticker}: no data`);
  const q = r.indicators.quote[0]!;
  const bars: Bar[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if (o == null || h == null || l == null || c == null || o <= 0 || c <= 0) continue; // a missing or zero bar is dropped, not guessed
    // The session's date in the exchange's own timezone (an open at 09:30 New York is the same calendar day there).
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: r.meta.exchangeTimezoneName }).format(new Date(r.timestamp[i]! * 1000));
    bars.push({ date, open: micro(o), high: micro(h), low: micro(l), close: micro(c) });
  }
  writeFileSync(file, JSON.stringify(bars));
  return bars;
}
