// The ratings service: price lookups, the outcome of a rated cross, and the venture index with its bounds.
import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';
import {
  GeckoPriceSource,
  MemoryLaunchStore,
  MemoryRatingStore,
  bootstrapMedian,
  clearingPriceHuman,
  collectOnce,
  outcomeBps,
  resolveDue,
  resolveOutcomes,
  ventureIndex,
  type PriceSource,
} from '../src/index.js';

const BASE = 'BaseMint1111111111111111111111111111111111';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('GeckoPriceSource', () => {
  const pool = (address: string, quote: string, reserve: string) => ({ attributes: { address, reserve_in_usd: reserve }, relationships: { base_token: { data: { id: `solana_${BASE}` } }, quote_token: { data: { id: `solana_${quote}` } } } });
  const make = (routes: (url: string) => Response, now = 2_000_000_000_000) => {
    const calls: string[] = [];
    const src = new GeckoPriceSource({ fetch: (async (u: RequestInfo | URL) => { calls.push(String(u)); return routes(String(u)); }) as typeof fetch, sleep: async () => {}, now: () => now, minIntervalMs: 0 });
    return { src, calls };
  };
  const T = 2_000_000_000 - 86_400;

  it('reads the open of the hour in the cross\'s quote asset, from its deepest pool', async () => {
    const { src, calls } = make((u) => (u.includes('/pools?page') ? json(200, { data: [pool('SHALLOW', QUOTE, '10'), pool('DEEP', QUOTE, '9000'), pool('OTHERQUOTE', 'SOMETHINGELSE', '99999')] }) : json(200, { data: { attributes: { ohlcv_list: [[T - 3600 * 5, 1, 1, 1, 1, 1], [T - 600, 0.42, 0.5, 0.4, 0.45, 9]] } } })));
    const r = await src.priceAt(BASE, QUOTE, T);
    expect(r).toMatchObject({ ok: true, point: { price: 0.42, barStart: T - 600, source: `geckoterminal:DEEP:${T - 600}` } });
    expect(calls[1]).toContain('/pools/DEEP/ohlcv/hour');
    expect(calls[1]).toContain('currency=token');
  });
  it('says why it cannot answer instead of estimating', async () => {
    expect(await make(() => json(200, { data: [pool('P', 'OTHER', '1')] })).src.priceAt(BASE, QUOTE, T)).toMatchObject({ ok: false, why: expect.stringMatching(/no pool pairs/) });
    expect(await make((u) => (u.includes('/pools?page') ? json(200, { data: [pool('P', QUOTE, '1')] }) : json(200, { data: { attributes: { ohlcv_list: [[T - 90_000, 1, 1, 1, 1, 1]] } } }))).src.priceAt(BASE, QUOTE, T)).toMatchObject({ ok: false, why: expect.stringMatching(/no trade in the hour/) });
    expect(await make(() => json(200, { data: [] })).src.priceAt(BASE, QUOTE, 1)).toMatchObject({ ok: false, why: expect.stringMatching(/175 days/) });
    expect(await make(() => json(200, { data: [] })).src.priceAt(BASE, QUOTE, 2_000_000_000 + 10)).toMatchObject({ ok: false, why: expect.stringMatching(/not happened/) });
    expect(await make((u) => (u.includes('/pools?page') ? json(200, { data: [pool('P', QUOTE, '1')] }) : json(500, {}))).src.priceAt(BASE, QUOTE, T)).toMatchObject({ ok: false, why: expect.stringMatching(/HTTP 500/) });
    expect(await make((u) => (u.includes('/pools?page') ? json(200, { data: [pool('P', QUOTE, '1')] }) : json(200, { data: { attributes: { ohlcv_list: [[T - 10, 0, 0, 0, 0, 0]] } } }))).src.priceAt(BASE, QUOTE, T)).toMatchObject({ ok: false, why: expect.stringMatching(/no usable price/) });
  });
  it('waits out a rate limit and tries again', async () => {
    let n = 0;
    const slept: number[] = [];
    const src = new GeckoPriceSource({ fetch: (async (u: RequestInfo | URL) => (String(u).includes('/pools?page') ? (n++ === 0 ? json(429, {}) : json(200, { data: [pool('P', QUOTE, '1')] })) : json(200, { data: { attributes: { ohlcv_list: [[T - 10, 2, 2, 2, 2, 1]] } } }))) as typeof fetch, sleep: async (ms) => { slept.push(ms); }, now: () => 2_000_000_000_000, minIntervalMs: 0 });
    expect(await src.priceAt(BASE, QUOTE, T)).toMatchObject({ ok: true });
    expect(slept[0]).toBeGreaterThanOrEqual(15_000);
  });
});

describe('outcome arithmetic', () => {
  it('turns the cross\'s price into quote tokens per base token, whatever the decimals and scale', () => {
    // 1_550_000 quote atoms (6 decimals) per 1_000_000_000 base atoms (9 decimals) = 1.55 quote per 1 base... per 1 base token: price / 1e6 / (scale / 1e9)
    expect(clearingPriceHuman(1_550_000n, 1_000_000_000n, 9, 6)).toBeCloseTo(1.55, 9);
    expect(clearingPriceHuman(2_000_000n, 1_000_000n, 6, 6)).toBeCloseTo(2, 9);
    expect(clearingPriceHuman(5n, 1_000n, 3, 9)).toBeCloseTo(5e-9 / 1, 12);
    expect(() => clearingPriceHuman(1n, 0n, 6, 6)).toThrow(RangeError);
  });
  it('is the move in basis points, floored at a total loss and held in 32 bits', () => {
    expect(outcomeBps(2, 3)).toBe(5_000);
    expect(outcomeBps(2, 1)).toBe(-5_000);
    expect(outcomeBps(2, 2)).toBe(0);
    expect(outcomeBps(2, 1e-12)).toBe(-9_999);
    expect(outcomeBps(1e-9, 1e9)).toBe(2_000_000_000);
    expect(() => outcomeBps(0, 1)).toThrow(RangeError);
  });
});

async function crossAccount(over: Record<string, unknown>) {
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  return { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), ...over } as never)) };
}
const clearing = (price: bigint) => ({ __option: 'Some', value: { price, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } });

describe('resolveOutcomes', () => {
  const HORIZON = 7 * 86_400;
  const now = 1_800_000_000;
  const startsTs = now - HORIZON - 3_600;
  const prices = (answer: (t: number) => { ok: boolean; price?: number; why?: string }): PriceSource & { asked: number[] } => {
    const p = { asked: [] as number[], async priceAt(_b: string, _q: string, t: number) { p.asked.push(t); const a = answer(t); return a.ok ? { ok: true as const, point: { price: a.price!, barStart: t, source: `test:${t}` } } : { ok: false as const, why: a.why! }; } };
    return p;
  };
  const rows = (...c: string[]) => c.map((cross, i) => ({ cross, baseMint: BASE, quoteMint: QUOTE, startsTs: startsTs + i }));

  it('writes the move from the clearing price to the price a horizon after trading began', async () => {
    const a = await crossAccount({ priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6, clearing: clearing(2_000_000n) });
    const store = new MemoryRatingStore(rows('C1'));
    const px = prices(() => ({ ok: true, price: 3 }));
    const r = await resolveOutcomes({ store, prices: px, account: async () => a, now: () => now, version: 'v0' });
    expect(r).toEqual([expect.objectContaining({ cross: 'C1', status: 'written', outcomeBps: 5_000 })]);
    expect(store.outcomes.get('C1')).toMatchObject({ outcomeBps: 5_000, horizonSecs: HORIZON, source: `test:${startsTs + HORIZON}` });
    expect(px.asked).toEqual([startsTs + HORIZON]);
  });
  it('does not ask for a crosses whose horizon has not passed, and does not write twice', async () => {
    const a = await crossAccount({ priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6, clearing: clearing(2_000_000n) });
    const store = new MemoryRatingStore([{ cross: 'EARLY', baseMint: BASE, quoteMint: QUOTE, startsTs: now - HORIZON + 10 }, ...rows('C1')]);
    const px = prices(() => ({ ok: true, price: 1 }));
    await resolveOutcomes({ store, prices: px, account: async () => a, now: () => now, version: 'v0' });
    expect([...store.outcomes.keys()]).toEqual(['C1']);
    await resolveOutcomes({ store, prices: px, account: async () => a, now: () => now, version: 'v0' });
    expect(px.asked).toHaveLength(1);
  });
  it('leaves a cross pending, with the reason, when the price, the account or the clearing price is missing', async () => {
    const good = await crossAccount({ priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6, clearing: clearing(1_000_000n) });
    const noClear = await crossAccount({ clearing: { __option: 'None' } });
    const store = new MemoryRatingStore(rows('NOPRICE', 'NOCROSS', 'NOCLEAR'));
    const r = await resolveOutcomes({
      store,
      prices: prices(() => ({ ok: false, why: 'the pool had no trade in the hour of that moment' })),
      account: async (a) => (a === 'NOCROSS' ? null : a === 'NOCLEAR' ? noClear : good),
      now: () => now,
      version: 'v0',
    });
    expect(r.map((x) => (x.status === 'pending' ? x.code : x.status))).toEqual(['NO_PRICE', 'NO_CROSS', 'NO_CLEARING']);
    expect(store.outcomes.size).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ venture index

const DAY = 86_400;
const T0 = Math.floor(Date.UTC(2026, 9, 5, 12) / 1000); // a Monday
const feed = (tokens: Record<string, unknown>[]) => (async () => json(200, tokens)) as unknown as typeof fetch;
const token = (id: string, launchpad: string | null, createdOffset: number, usdPrice = 0.001, liquidity = 20_000) => ({ id, launchpad, usdPrice, liquidity, holderCount: 10, firstPool: { createdAt: new Date((T0 + createdOffset) * 1000).toISOString().replace('.000Z', 'Z') } });

describe('collecting launches', () => {
  it('records new launches once, under their venue, skips what cannot be followed, and logs each poll', async () => {
    const store = new MemoryLaunchStore();
    const list = [token('A', 'pump.fun', 0), token('B', 'met-dbc', 10), { id: 'C', usdPrice: 0.1, liquidity: 1 }, { id: 'D', launchpad: 'pump.fun', firstPool: { createdAt: '2026-10-05T00:00:00Z' } }, token('E', null, 20)];
    const r1 = await collectOnce(store, { fetch: feed(list), now: () => T0 + 100 });
    expect(r1).toEqual({ returned: 5, fresh: 3, skipped: 2 });
    expect(store.launches().map((l) => `${l.mint}:${l.venue}`).sort()).toEqual(['A:pump.fun', 'B:met-dbc', 'E:unknown']);
    const r2 = await collectOnce(store, { fetch: feed(list), now: () => T0 + 200 });
    expect(r2.fresh).toBe(0);
    expect(store.polls()).toEqual([{ at: T0 + 100, returned: 5, fresh: 3 }, { at: T0 + 200, returned: 5, fresh: 0 }]);
  });
  it('refuses a feed that is not a list', async () => {
    await expect(collectOnce(new MemoryLaunchStore(), { fetch: (async () => json(200, { error: 'x' })) as unknown as typeof fetch })).rejects.toThrow(/did not answer a list/);
    await expect(collectOnce(new MemoryLaunchStore(), { fetch: (async () => json(503, {})) as unknown as typeof fetch })).rejects.toThrow(/HTTP 503/);
  });
});

describe('resolving and indexing', () => {
  const horizonDays = 7;
  const setup = async () => {
    const store = new MemoryLaunchStore();
    // Ten launches on one venue in one week, all first seen at 0.001 USD.
    const ids = Array.from({ length: 10 }, (_, i) => `PUMP${i}`);
    await collectOnce(store, { fetch: feed(ids.map((id, i) => token(id, 'pump.fun', i * 60))), now: () => T0 + 700 });
    await collectOnce(store, { fetch: feed([token('DBC0', 'met-dbc', 0), token('DBC1', 'met-dbc', 30)]), now: () => T0 + 800 });
    return { store, ids };
  };
  const due = T0 + horizonDays * DAY;
  const search = (answers: Record<string, { usdPrice: number; liquidity: number } | null>) => (async (u: RequestInfo | URL) => {
    const q = decodeURIComponent(String(u).split('query=')[1]!);
    const a = answers[q];
    return json(200, a ? [{ id: q, ...a }] : []);
  }) as unknown as typeof fetch;

  it('reads the price at the horizon, and counts what is alive, dead, unlisted and late', async () => {
    const { store } = await setup();
    const answers: Record<string, { usdPrice: number; liquidity: number } | null> = {
      PUMP0: { usdPrice: 0.002, liquidity: 50_000 }, PUMP1: { usdPrice: 0.0005, liquidity: 9_000 }, PUMP2: { usdPrice: 0.004, liquidity: 30_000 }, PUMP3: { usdPrice: 0.001, liquidity: 6_000 },
      PUMP4: { usdPrice: 0.0001, liquidity: 100 }, PUMP5: null, PUMP6: { usdPrice: 0.003, liquidity: 12_000 }, PUMP7: { usdPrice: 0.0007, liquidity: 7_000 }, PUMP8: { usdPrice: 0.0015, liquidity: 20_000 }, PUMP9: { usdPrice: 0.0009, liquidity: 5_500 },
      DBC0: { usdPrice: 0.001, liquidity: 10_000 }, DBC1: null,
    };
    // The resolver runs within the grace window of PUMP0..PUMP9's horizon (their first pools were created 0..540 s after T0).
    const t = await resolveDue(store, horizonDays, { fetch: search(answers), now: () => due + 3_600 });
    expect(t).toEqual({ priced: 9, noLiquidity: 1, unresolved: 2, missed: 0 });
    const idx = ventureIndex(store, horizonDays, due + 3_700);
    const pump = idx.rows.find((r) => r.venue === 'pump.fun')!;
    expect(pump).toMatchObject({ week: '2026-10-05', observed: 10, due: 10, alive: 8, unresolved: 1 });
    expect(pump.survival.lower).toBeCloseTo(0.8, 9);
    expect(pump.survival.upper).toBeCloseTo(0.9, 9);
    // Returns among the eight alive: 1.0, -0.5, 3.0, 0.0, 2.0, -0.3, 0.5, -0.1; median of the sorted list -0.5,-0.3,-0.1,0,0.5,1,2,3 is 0.25.
    expect(pump.medianReturn.observedOnly!.median).toBeCloseTo(0.25, 9);
    // Counting the two non-alive as a total loss: -1,-1 plus the eight; median of the ten is (-0.1 + 0) / 2 = -0.05.
    expect(pump.medianReturn.deadAsLoss!.median).toBeCloseTo(-0.05, 9);
    const dbc = idx.rows.find((r) => r.venue === 'met-dbc')!;
    expect(dbc).toMatchObject({ observed: 2, due: 2, alive: 1 });
    expect(dbc.medianReturn.observedOnly).toBeNull(); // two launches: no interval is claimed
    expect(idx.venuesSeen).toEqual(['met-dbc', 'pump.fun']);
  });
  it('records a launch resolved long after its horizon as missed rather than reading today\'s price as the price then', async () => {
    const { store } = await setup();
    const t = await resolveDue(store, horizonDays, { fetch: search({}), now: () => due + 3 * DAY });
    expect(t.missed).toBe(12);
    const idx = ventureIndex(store, horizonDays, due + 3 * DAY);
    expect(idx.rows.every((r) => r.survival.lower === 0 && r.survival.upper === 1)).toBe(true);
  });
  it('does not resolve before the horizon, does not resolve twice, and retries a failed request within the window', async () => {
    const { store } = await setup();
    expect(await resolveDue(store, horizonDays, { fetch: search({}), now: () => due - 3_600 })).toEqual({ priced: 0, noLiquidity: 0, unresolved: 0, missed: 0 });
    const down = (async () => json(503, {})) as unknown as typeof fetch;
    expect(await resolveDue(store, horizonDays, { fetch: down, now: () => due + 3_600 })).toEqual({ priced: 0, noLiquidity: 0, unresolved: 0, missed: 0 });
    expect(store.resolution('PUMP0', horizonDays)).toBeNull();
    const ok = await resolveDue(store, horizonDays, { fetch: search({ PUMP0: { usdPrice: 0.001, liquidity: 9_000 } }), now: () => due + 3_700 });
    expect(ok.priced).toBe(1);
    expect((await resolveDue(store, horizonDays, { fetch: search({ PUMP0: { usdPrice: 5, liquidity: 9_000 } }), now: () => due + 3_800 })).priced).toBe(0);
    expect(store.resolution('PUMP0', horizonDays)).toMatchObject({ priceUsd: 0.001 });
  });
  it('reports polls that returned nothing already seen, which may have missed launches', async () => {
    const store = new MemoryLaunchStore();
    await collectOnce(store, { fetch: feed([token('X1', 'pump.fun', 0), token('X2', 'pump.fun', 1)]), now: () => T0 });
    await collectOnce(store, { fetch: feed([token('X2', 'pump.fun', 1), token('X3', 'pump.fun', 2)]), now: () => T0 + 60 });
    await collectOnce(store, { fetch: feed([token('Y1', 'pump.fun', 3), token('Y2', 'pump.fun', 4)]), now: () => T0 + 120 });
    const c = ventureIndex(store, 7, T0 + 200).collection;
    expect(c).toMatchObject({ polls: 3, overflowPolls: 2, firstPoll: T0, lastPoll: T0 + 120 });
    expect(c.overflowShare).toBeCloseTo(2 / 3, 9);
  });
  it('bootstrap intervals are seeded, bracket the median, and are withheld for fewer than five values', () => {
    const xs = [-0.5, -0.3, -0.1, 0, 0.5, 1, 2, 3];
    const a = bootstrapMedian(xs, { seed: 3 })!;
    expect(a).toEqual(bootstrapMedian(xs, { seed: 3 }));
    expect(a.lo).toBeLessThanOrEqual(a.median);
    expect(a.hi).toBeGreaterThanOrEqual(a.median);
    expect(bootstrapMedian([1, 2, 3, 4])).toBeNull();
  });
});

describe('a signer exists for the test accounts', () => {
  it('generates addresses', async () => {
    expect((await generateKeyPairSigner()).address.length).toBeGreaterThan(30);
  });
});

describe('survival label for the OVS bar', () => {
  const NOW = 1_800_000_000;
  const mk = (cross: string, startsTs: number) => ({ cross, baseMint: `M${cross}`, startsTs, score: 70, organicLowerBps: 6000, matchedBase: 100n, ratedAt: startsTs });
  const search = (answers: Record<string, { usdPrice: number; liquidity: number } | null>) => (async (u: RequestInfo | URL) => {
    const q = decodeURIComponent(String(u).split('query=')[1]!);
    const a = answers[q];
    return json(200, a ? [{ id: q, ...a }] : []);
  }) as unknown as typeof fetch;
  it('records alive, dead and unlisted at the horizon, once, and calls a late look missed', async () => {
    const { SurvivalLog, resolveSurvival } = await import('../src/index.js');
    const log = new SurvivalLog(null);
    const start = NOW - 30 * DAY - 3_600;
    const crosses = [mk('A', start), mk('B', start), mk('C', start), mk('LATE', NOW - 40 * DAY), mk('EARLY', NOW - 10 * DAY)];
    const t = await resolveSurvival(crosses, log, 30, { fetch: search({ MA: { usdPrice: 1, liquidity: 9_000 }, MB: { usdPrice: 1, liquidity: 10 }, MC: null }), now: () => NOW });
    expect(t).toEqual({ alive: 1, dead: 1, unresolved: 1, missed: 1 });
    expect(log.get('EARLY', 30)).toBeNull();
    const again = await resolveSurvival(crosses, log, 30, { fetch: search({ MA: { usdPrice: 9, liquidity: 1 } }), now: () => NOW });
    expect(again).toEqual({ alive: 0, dead: 0, unresolved: 0, missed: 0 });
    expect(log.get('A', 30)!.status).toBe('alive');
  });
});
