// K2 validation against tokenized stocks' own weekend prices (ADR-0951). Read-only, public data:
//   * the xStock mint for each ticker is found in Jupiter's token list (the Backed metadata icon, a mint address starting "Xs", the deepest liquidity); impostors with the same icon and
//     almost no liquidity exist, so liquidity decides and a mint under 100,000 USD of liquidity is not used;
//   * the token's hourly prices come from its deepest USDC pool on GeckoTerminal (the public API serves 180 days);
//   * the underlying's hourly prices and daily history come from Yahoo Finance's public chart endpoint.
// Raw prices are cached under .tmp/risk-history (git-ignored) and never committed: the sources' terms do not allow redistribution. Only derived statistics are written to data/.
//
//   pnpm --filter @opening-cross/risk exec tsx tools/tokenized-validate.ts [TICKER ...]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, DEFAULT_VALUATION, type HourBar, breaches, decide, fairValue, engineEvents, gapsOf, tracking, underwaterMove, weekendObservations } from '../src/index.js';
import { UNIVERSE, fetchBars } from './fetch-history.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cache = join(root, '.tmp', 'risk-history', 'tokenized');
mkdirSync(cache, { recursive: true });
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dateOf = (t: number) => ny.format(new Date(t * 1000));
const MIN_LIQUIDITY_USD = 100_000;
const DAYS = 175; // GeckoTerminal's public API refuses data older than 180 days

async function getJson<T>(url: string, tries = 8, headers: Record<string, string> = {}): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) {
      await sleep(15_000 + i * 5_000);
      continue;
    }
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return (await res.json()) as T;
  }
  throw new Error(`${url} kept rate limiting`);
}

interface JupToken { id: string; symbol: string; icon?: string; liquidity?: number; dev?: string; mintAuthority?: string; freezeAuthority?: string; holderCount?: number }

async function discoverMint(ticker: string): Promise<(JupToken & { liquidity: number }) | null> {
  const list = await getJson<JupToken[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${ticker}x`);
  const genuine = list.filter((t) => t.symbol === `${ticker}x` && /xstocks-metadata\.backed\.fi/.test(t.icon ?? '') && t.id.startsWith('Xs'));
  genuine.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
  const best = genuine[0];
  return best && (best.liquidity ?? 0) >= MIN_LIQUIDITY_USD ? { ...best, liquidity: best.liquidity ?? 0 } : null;
}

async function deepestUsdcPool(mint: string): Promise<{ address: string; liquidityUsd: number; created: string } | null> {
  const j = await getJson<{ data: { attributes: { address: string; name: string; reserve_in_usd: string; pool_created_at: string } }[] }>(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
  const pools = j.data.map((p) => p.attributes).filter((p) => / \/ USDC$/.test(p.name));
  pools.sort((a, b) => Number(b.reserve_in_usd) - Number(a.reserve_in_usd));
  const p = pools[0];
  return p ? { address: p.address, liquidityUsd: Number(p.reserve_in_usd), created: p.pool_created_at } : null;
}

async function tokenHours(ticker: string, pool: string): Promise<HourBar[]> {
  const file = join(cache, `${ticker}x-${pool}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as HourBar[];
  const floor = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  const bars = new Map<number, HourBar>();
  let before = Math.floor(Date.now() / 1000) + 3_600;
  for (let page = 0; page < 8; page++) {
    await sleep(2_300);
    const j = await getJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&before_timestamp=${before}`);
    const list = j.data.attributes.ohlcv_list;
    if (list.length === 0) break;
    for (const [t, o, h, l, c] of list) bars.set(t!, { t: t!, o: o!, h: h!, l: l!, c: c! });
    const oldest = Math.min(...list.map((r) => r[0]!));
    if (oldest <= floor) break;
    before = oldest;
  }
  const out = [...bars.values()].filter((b) => b.t >= floor && b.o > 0 && b.c > 0).sort((a, b) => a.t - b.t);
  writeFileSync(file, JSON.stringify(out));
  return out;
}

async function underlyingHours(ticker: string): Promise<HourBar[]> {
  const file = join(cache, `${ticker}-1h.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as HourBar[];
  const body = await getJson<{ chart: { result?: { timestamp: number[]; indicators: { quote: Record<'open' | 'high' | 'low' | 'close', (number | null)[]>[] } }[] } }>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1h&includePrePost=false`,
    4,
    { 'user-agent': 'Mozilla/5.0 (opening-cross risk research)' },
  );
  const r = body.chart.result?.[0];
  if (!r) throw new Error(`${ticker}: no hourly data`);
  const q = r.indicators.quote[0]!;
  const out: HourBar[] = [];
  r.timestamp.forEach((t, i) => {
    const [o, h, l, c] = [q.open![i], q.high![i], q.low![i], q.close![i]];
    if (o != null && h != null && l != null && c != null && o > 0 && c > 0) out.push({ t, o, h, l, c });
  });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const tickers = wanted.length ? wanted : [...UNIVERSE];
const rows: Record<string, unknown>[] = [];
const allObs: ReturnType<typeof weekendObservations> = [];
const ltvByTicker = new Map<string, Map<string, number>>();
const skipped: { ticker: string; why: string }[] = [];
for (const ticker of tickers) {
  try {
    const mint = await discoverMint(ticker);
    if (!mint) { skipped.push({ ticker, why: `no genuine xStock mint with at least ${MIN_LIQUIDITY_USD} USD of liquidity` }); continue; }
    await sleep(2_300);
    const pool = await deepestUsdcPool(mint.id);
    if (!pool) { skipped.push({ ticker, why: 'no USDC pool' }); continue; }
    const token = await tokenHours(ticker, pool.address);
    const under = await underlyingHours(ticker);
    const obs = weekendObservations(`${ticker}x`, token, under, dateOf);
    const events = engineEvents(ticker, gapsOf(await fetchBars(ticker, '10y')), DEFAULT_POLICY, 100, ['weekend', 'long']);
    const ltv = new Map(events.map((e) => [e.date, e.ltvBps]));
    ltvByTicker.set(ticker, ltv);
    allObs.push(...obs);
    const t = tracking(obs);
    const b = breaches(obs, ltv, DEFAULT_POLICY.liquidationBonusBps);
    const wicks = obs.filter((o) => ltv.has(o.date) && o.tokenLow / o.tokenClose - 1 < underwaterMove(ltv.get(o.date)!, DEFAULT_POLICY.liquidationBonusBps)).map((o) => ({ date: o.date, ltvBps: ltv.get(o.date), lineBps: Math.round(underwaterMove(ltv.get(o.date)!, DEFAULT_POLICY.liquidationBonusBps) * 10_000), tokenLowBps: Math.round((o.tokenLow / o.tokenClose - 1) * 10_000), tokenPreOpenBps: Math.round((o.tokenPreOpen / o.tokenClose - 1) * 10_000), gapBps: Math.round((o.monday / o.friday - 1) * 10_000), coverage: Number(o.coverage.toFixed(2)) }));
    // What the band rule (fair-value.ts, liquidation.ts) does with each of those prints, against a rule that liquidates on the spot price: a loan opened at the engine's LTV for that weekend,
    // liquidated when its LTV rises 500 bps above where it began, valued at the glitch print plus the underlying's Friday close as the only other reference.
    const replay = obs
      .filter((o) => ltv.has(o.date) && o.tokenLow / o.tokenClose - 1 < underwaterMove(ltv.get(o.date)!, DEFAULT_POLICY.liquidationBonusBps))
      .map((o) => {
        const l = ltv.get(o.date)!;
        const unit = 1_000_000;
        const fridayPrice = BigInt(Math.round(o.friday * unit));
        const printPrice = BigInt(Math.round(o.tokenLow * unit * (o.friday / o.tokenClose)));
        const now = o.closeT + 36 * 3600;
        const v = fairValue([{ kind: 'reference', price: printPrice, at: now }, { kind: 'last-close', price: fridayPrice, at: o.closeT }], { ...DEFAULT_VALUATION, now, marketOpen: false });
        const pos = { collateral: 1_000_000_000n, collateralDecimals: 9, debt: (fridayPrice * 1_000_000_000n * BigInt(l)) / (10_000n * 1_000_000_000n) };
        const band = decide(pos, v, { liquidationLtvBps: l + 500, bonusBps: DEFAULT_POLICY.liquidationBonusBps, maxBandWidthBps: 600 });
        const spotLtv = Number((pos.debt * 10_000n) / printPrice);
        return { date: o.date, bandRule: band.action, bandReasons: band.reasons.slice(0, 2), spotRule: spotLtv >= l + 500 ? 'liquidate' : 'hold', spotLtvBps: spotLtv };
      });
    for (const r of replay) console.log(`  REPLAY ${ticker}x ${r.date}: spot-price rule ${r.spotRule} (LTV ${r.spotLtvBps}), band rule ${r.bandRule} (${r.bandReasons.join('; ')})`);
    for (const w of wicks) console.log(`  WICK ${ticker}x ${w.date} low ${w.tokenLowBps} bps vs line ${w.lineBps} (ltv ${w.ltvBps}); pre-open ${w.tokenPreOpenBps}, Monday gap ${w.gapBps}, coverage ${w.coverage}`);
    rows.push({ weekendLowBreachCases: wicks, weekendLowReplay: replay, ticker: `${ticker}x`, mint: mint.id, tokenProgramDev: mint.dev ?? null, mintAuthority: mint.mintAuthority ?? null, freezeAuthority: mint.freezeAuthority ?? null, holders: mint.holderCount ?? null, jupiterLiquidityUsd: Math.round(mint.liquidity), pool: pool.address, poolLiquidityUsd: Math.round(pool.liquidityUsd), poolCreated: pool.created, tokenHours: token.length, closures: obs.length, meanCoverage: obs.length ? obs.reduce((s, o) => s + o.coverage, 0) / obs.length : null, tracking: t, breaches: b });
    console.log(`${ticker}x`.padEnd(7), `closures ${String(obs.length).padStart(3)}  coverage ${(obs.reduce((s, o) => s + o.coverage, 0) / Math.max(1, obs.length)).toFixed(2)}  basis@close median ${t.closeBasisMedianBps.toFixed(1)} bps (p95 ${t.closeBasisP95Bps.toFixed(0)})  error token-implied ${t.tokenImpliedErrorMedianBps.toFixed(0)} vs naive ${t.naiveErrorMedianBps.toFixed(0)} bps  beats naive ${(t.tokenBeatsNaive * 100).toFixed(0)}%  breaches gap/pre/low ${b.gapBreaches}/${b.preOpenBreaches}/${b.weekendLowBreaches} of ${b.n}`);
  } catch (e) {
    skipped.push({ ticker, why: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    console.log(`${ticker}x`.padEnd(7), 'skipped:', skipped.at(-1)!.why);
  }
}
const ltvAll = new Map<string, number>();
const pooled = { tracking: tracking(allObs), breaches: { n: 0, gapBreaches: 0, preOpenBreaches: 0, weekendLowBreaches: 0, meanLtvBps: 0, worstTokenDrawdownBps: 0, worstGapBps: 0 } };
let ltvSum = 0;
for (const o of allObs) {
  const l = ltvByTicker.get(o.symbol.slice(0, -1))?.get(o.date);
  if (l === undefined) continue;
  const one = breaches([o], new Map([[o.date, l]]), DEFAULT_POLICY.liquidationBonusBps);
  pooled.breaches.n += one.n;
  pooled.breaches.gapBreaches += one.gapBreaches;
  pooled.breaches.preOpenBreaches += one.preOpenBreaches;
  pooled.breaches.weekendLowBreaches += one.weekendLowBreaches;
  pooled.breaches.worstTokenDrawdownBps = Math.min(pooled.breaches.worstTokenDrawdownBps, one.worstTokenDrawdownBps);
  pooled.breaches.worstGapBps = Math.min(pooled.breaches.worstGapBps, one.worstGapBps);
  ltvSum += l;
}
pooled.breaches.meanLtvBps = pooled.breaches.n ? ltvSum / pooled.breaches.n : NaN;
void ltvAll;
console.log('\npooled', JSON.stringify(pooled, null, 1));
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(outDir, `tokenized-weekends-${date}.json`),
  `${JSON.stringify({ schema: 'opening-cross/risk/tokenized-weekends/v1', generatedAt: date, sources: { token: 'GeckoTerminal public API, deepest USDC pool per mint, hourly, last 175 days', underlying: 'Yahoo Finance public chart endpoint, regular-session hourly bars', mints: 'Jupiter token list v2 (Backed xStocks metadata icon, mint prefix Xs, liquidity of at least 100000 USD)' }, policy: DEFAULT_POLICY, perToken: rows, pooled, skipped }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 1)}\n`,
);
console.log(`wrote data/tokenized-weekends-${date}.json`);
