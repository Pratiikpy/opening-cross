// The premium monitor end to end with controlled sources: a universe is built from the authenticity registry,
// a round is measured and stored in Postgres, and the HTTP API reports it. The sources are fakes so the numbers
// are known; the live sources are exercised by packages/premium (tools/measure.ts) and its evidence file.
import { describe, expect, it } from 'vitest';
import { loadBundledBook } from '@opening-cross/authenticity';
import { type IssuerState, type JupiterQuote, type Reference, NoRouteError, USDC_MINT, multiplierE12 } from '@opening-cross/premium';
import { type RoundDeps, buildUniverse, insertObservations, measureRound } from '@opening-cross/premium-service';
import { buildServer } from '../../../services/api/src/server.js';
import { freshDb } from '../src/db.js';

const book = loadBundledBook();
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const NOW = 1_800_000_000;

const ref = (ticker: string, priceE6: bigint): Reference => ({ kind: 'hip3_oracle', ticker, priceE6, readAt: NOW });
const state = (ticker: string, symbol: string, mint: string, period: string, halted = false): IssuerState => ({ ticker, symbol, mint, halted, period, nextChangeAt: null });

// TSLA sells at 383.00 and buys at 382.50; NVDA has no route at all.
const quote = async (inMint: string, outMint: string, amount: bigint): Promise<JupiterQuote> => {
  if (inMint === NVDAX || outMint === NVDAX) throw new NoRouteError('no route');
  if (inMint === USDC_MINT) return { inputMint: inMint, outputMint: outMint, inAmount: amount, outAmount: (amount * 10n ** 8n * 100n) / 38_300_000_000n, priceImpactBpsX100: 12n, routeLabels: ['Raydium CLMM'], contextSlot: 1 };
  return { inputMint: inMint, outputMint: outMint, inAmount: amount, outAmount: (amount * 38_250_000_000n) / 10n ** 8n / 100n, priceImpactBpsX100: 9n, routeLabels: ['BinaryFi'], contextSlot: 1 };
};

const deps = (period: string): RoundDeps => ({
  book,
  quote,
  fetchReferences: async () => [ref('TSLA', 382_920_000n), ref('NVDA', 230_720_000n)],
  fetchIssuer: async () => [state('TSLA', 'TSLAx', TSLAX, period), state('NVDA', 'NVDAx', NVDAX, period)],
  readFacts: async (mints) => new Map(mints.map((m) => [m, { mint: m, decimals: 8, multiplierE12: multiplierE12(1) }])),
  now: () => NOW,
  sizesUsd: [1000, 10000],
  paceMs: 0,
});

describe.skipIf(!process.env.DATABASE_URL)('premium monitor', { timeout: 60_000 }, () => {
  it('builds the universe from genuine xStocks that have a reference and a route', async () => {
    const u = await buildUniverse(deps('market'));
    expect(u.entries.map((e) => e.ticker)).toEqual(['TSLA']);
    expect(u.dropped).toEqual([{ ticker: 'NVDA', reason: 'no route' }]);
  });

  it('measures a round, stores every observation and serves the summary over HTTP', async () => {
    const { db } = await freshDb();
    const d = deps('market');
    const universe = await buildUniverse(d);
    const obs = await measureRound(d, universe);
    expect(obs).toHaveLength(4); // 2 sizes x 2 legs, one token
    expect(await insertObservations(db, 'mainnet-beta', obs)).toBe(4);

    // A second round in another session, with the issuer halting: the exclusions must be counted, not dropped.
    const halted = { ...deps('extended'), now: () => NOW + 300, fetchIssuer: async () => [state('TSLA', 'TSLAx', TSLAX, 'extended', true)] };
    await insertObservations(db, 'mainnet-beta', await measureRound(halted, universe));

    const app = await buildServer({ db, account: async () => null, lifetime: async () => ({}) as never, network: 'localnet' });
    const summary = (await app.inject({ method: 'GET', url: '/v1/premium/summary?days=90' })).json();
    expect(summary.cluster).toBe('mainnet-beta');
    expect(summary.coverage).toMatchObject({ rounds: 2, tickers: 1 });
    const buy = summary.groups.find((g: { session: string; leg: string; sizeUsd: number }) => g.session === 'regular' && g.leg === 'buy' && g.sizeUsd === 1000);
    expect(buy.summary.n).toBe(1);
    // Bought at 383.00 against a 382.92 reference: about +2.1 bps, i.e. 209 in basis points x 100.
    expect(Number(buy.summary.medianBpsX100)).toBeGreaterThan(190);
    expect(Number(buy.summary.medianBpsX100)).toBeLessThan(230);
    const sell = summary.groups.find((g: { session: string; leg: string; sizeUsd: number }) => g.session === 'regular' && g.leg === 'sell' && g.sizeUsd === 1000);
    expect(Number(sell.summary.medianBpsX100)).toBeLessThan(0);
    const excluded = summary.groups.filter((g: { session: string }) => g.session === 'post' || g.session === 'pre');
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every((g: { summary: { n: number }; excluded: Record<string, number> }) => g.summary.n === 0 && g.excluded.issuer_halted === 1)).toBe(true);

    const latest = (await app.inject({ method: 'GET', url: '/v1/premium/latest' })).json();
    expect(latest.observations).toHaveLength(4);
    expect(latest.observations.every((o: { at: number; status: string }) => o.at === NOW + 300 && o.status === 'issuer_halted')).toBe(true);
  });

  it('refuses a nonsense window and reports an empty record plainly', async () => {
    const { db } = await freshDb();
    const app = await buildServer({ db, account: async () => null, lifetime: async () => ({}) as never, network: 'localnet' });
    for (const days of ['0', '91', 'abc', '1.5']) {
      expect((await app.inject({ method: 'GET', url: `/v1/premium/summary?days=${days}` })).statusCode, days).toBe(400);
    }
    const empty = (await app.inject({ method: 'GET', url: '/v1/premium/summary' })).json();
    expect(empty.groups).toEqual([]);
    expect(empty.coverage).toEqual({ rounds: 0, tickers: 0, first: null, last: null });
    expect((await app.inject({ method: 'GET', url: '/v1/premium/latest' })).json().observations).toEqual([]);
  });
});
