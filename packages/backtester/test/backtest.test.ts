import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type HistoricalCross, ReplayError, backtest, checkBaseline, clearBook, crossFrom, formatReport, isUnreplayable, lastSecondBid, loadFromApi, marketMaker, passiveBuy, replayCross, toJson } from '../src/index.js';

type Fixture = { address: string; proof: Parameters<typeof crossFrom>[1]; detail: Parameters<typeof crossFrom>[2] };
const real = JSON.parse(readFileSync(new URL('./fixtures/real-crosses.json', import.meta.url), 'utf8')) as Record<'printedEscrow' | 'mint' | 'noPrint', Fixture>;
const fromFixture = (f: Fixture): HistoricalCross => {
  const c = crossFrom(f.address, f.proof, f.detail);
  if (isUnreplayable(c)) throw new Error(c.reason);
  return c;
};

const G = { min: 1_000_000n, tick: 50_000n, ticks: 41, priceScale: 1_000_000n };
const synthetic = (over: Partial<HistoricalCross> = {}): HistoricalCross => ({
  address: 'X', baseMint: 'B', quoteMint: 'Q', closeTs: 100n, kind: 'reopen', supplyMode: 'escrow', disclosure: 'open', grid: G, referencePrice: null, minMatched: 0n, maxImbalanceBps: null, feeBps: 25,
  book: [{ side: 'sell', price: 1_550_000n, quantity: 200_000_000n }, { side: 'buy', price: 1_600_000n, quantity: 100_000_000n }], recorded: { printed: true, price: 1_550_000n, matched: 100_000_000n, rationed: 'sell' }, oracleGuard: false, ...over,
});

describe('real crosses from the live API', () => {
  it('the replay of each cross as it was reproduces what the program recorded', () => {
    for (const f of [real.printedEscrow, real.mint, real.noPrint]) {
      const c = fromFixture(f);
      const r = replayCross(c, null, null);
      expect(r.baselineCheck, f.address).toBe('match');
    }
    const escrow = fromFixture(real.printedEscrow);
    expect(escrow.recorded).toEqual({ printed: true, price: 1_550_000n, matched: 100_000_000n, rationed: 'sell' });
    expect(escrow.supplyMode).toBe('escrow');
    expect(fromFixture(real.noPrint).recorded).toEqual({ printed: false, reason: 'NoCross' });
    expect(fromFixture(real.mint).supplyMode).toBe('mint');
  });

  it('adding a buy to the real escrow cross changes the price exactly as the clearing rule says', () => {
    const c = fromFixture(real.printedEscrow);
    // The real book: bid 273.5 at 1.45 (market maker), ask 200 at 1.55, taker bid 100 at 1.60. Add a 150 bid at 1.60. At 1.55 demand strictly
    // above the price (250) would exceed the volume (200), so 1.55 is not a valid price; the lowest valid price is 1.60, where the 250 of demand
    // is rationed down to the 200 on offer.
    const withUs = clearBook(c, [{ side: 'buy', price: 1_600_000n, quantity: 150_000_000n }]);
    expect(withUs.outcome).toEqual({ printed: true, price: 1_600_000n, matched: 200_000_000n, rationed: 'buy' });
    // The existing 100 and the new 150 share the 200 in proportion (buyers floor): 150 * 200 / 250 = 120.
    expect(withUs.fills.at(-1)).toBe(120_000_000n);
    expect(withUs.fills.at(-2)).toBe(80_000_000n);
  });
});

describe('clearing and guards', () => {
  it('prints at the lowest price of the largest volume and rations the long side', () => {
    expect(clearBook(synthetic()).outcome).toEqual({ printed: true, price: 1_550_000n, matched: 100_000_000n, rationed: 'sell' });
  });

  it('applies the minimum volume and the imbalance guard like the program', () => {
    expect(clearBook(synthetic({ minMatched: 150_000_000n })).outcome).toEqual({ printed: false, reason: 'BelowMinimumVolume' });
    // demand 100, supply 200 at the clearing price: imbalance 100 of 100 matched = 10,000 bps
    expect(clearBook(synthetic({ maxImbalanceBps: 5_000n })).outcome).toEqual({ printed: false, reason: 'ImbalanceTooHigh' });
    expect(clearBook(synthetic({ maxImbalanceBps: 10_000n })).outcome.printed).toBe(true);
    expect(clearBook(synthetic({ book: [{ side: 'buy', price: 1_000_000n, quantity: 5n }, { side: 'sell', price: 2_000_000n, quantity: 5n }] })).outcome).toEqual({ printed: false, reason: 'NoCross' });
  });

  it('says a verdict that rests on the oracle or a halt cannot be confirmed from the book', () => {
    const c = synthetic({ recorded: { printed: false, reason: 'OracleDivergence' } });
    expect(checkBaseline(c, clearBook(c).outcome)).toBe('external');
    expect(checkBaseline(synthetic({ recorded: { printed: true, price: 1_600_000n, matched: 1n, rationed: null } }), clearBook(synthetic()).outcome)).toBe('mismatch');
    expect(checkBaseline(synthetic({ recorded: null }), clearBook(synthetic()).outcome)).toBe('external');
  });
});

describe('replaying a strategy', () => {
  it('prices fills the way the program claims: buyers round the cost up, sellers get the floor less the fee', () => {
    const mm = { name: 'two-sided', description: '', orders: () => [{ side: 'buy' as const, price: 1_600_000n, quantity: 3n }, { side: 'sell' as const, price: 1_500_000n, quantity: 1_000_000n }] };
    const r = replayCross(synthetic(), mm, null);
    expect(r.participated).toBe(true);
    const [buy, sell] = r.orders;
    // The sell at 1.50 is below the clearing price, so it fills in full at 1.55 (or is rationed with the other seller).
    expect(buy!.filled).toBe(3n);
    expect(buy!.quote).toBe(5n); // ceil(3 * 1.55) = 5
    expect(sell!.feePaid).toBe((sell!.quote + sell!.feePaid) * 25n / 10_000n);
  });

  it('refuses an order off the grid, and a sell in a cross that mints its supply', () => {
    const off = { name: 'off', description: '', orders: () => [{ side: 'buy' as const, price: 1_510_000n, quantity: 1n }] };
    expect(() => replayCross(synthetic(), off, null)).toThrow(ReplayError);
    const sell = { name: 'sell', description: '', orders: () => [{ side: 'sell' as const, price: 1_500_000n, quantity: 1n }] };
    expect(() => replayCross(synthetic({ supplyMode: 'mint' }), sell, null)).toThrow(/mints its supply/);
  });

  it('sits out a sealed cross and a cross the strategy declines, and says so', () => {
    const s = passiveBuy({ quantity: 10n, slackBps: 100 });
    expect(replayCross(synthetic({ disclosure: 'sealed' }), s, 1_500_000n)).toMatchObject({ participated: false, note: expect.stringContaining('sealed') });
    expect(replayCross(synthetic(), s, null)).toMatchObject({ participated: false, note: 'the strategy sat this cross out' });
  });

  it('uses the last printed price of the pair as the reference, in the order the crosses closed', () => {
    const a = synthetic({ address: 'A', closeTs: 10n, recorded: { printed: true, price: 1_500_000n, matched: 1n, rationed: null }, book: [] });
    const b = synthetic({ address: 'B', closeTs: 20n });
    const c = synthetic({ address: 'C', closeTs: 30n, baseMint: 'OTHER' });
    const seen: Record<string, bigint | null> = {};
    const spy = { name: 'spy', description: '', orders: (ctx: { cross: HistoricalCross; reference: bigint | null }) => ((seen[ctx.cross.address] = ctx.reference), []) };
    backtest([c, b, a], spy);
    expect(seen).toEqual({ A: null, B: 1_500_000n, C: null });
  });

  it('measures the effect of the strategy\'s own orders on the price and on whether the cross prints', () => {
    const crosses = [synthetic({ address: 'A', closeTs: 1n }), synthetic({ address: 'B', closeTs: 2n, minMatched: 150_000_000n, recorded: { printed: false, reason: 'BelowMinimumVolume' } })];
    const r = backtest(crosses, lastSecondBid({ quantity: 100_000_000n }));
    expect(r.summary.crosses).toBe(2);
    expect(r.summary.baseline).toEqual({ match: 2, mismatch: 0, external: 0 });
    expect(r.summary.participated).toBe(2);
    // On B the extra 100 of demand lifts matched volume from 100 to 200, past the 150 minimum: the strategy made it print.
    expect(r.summary.caused).toEqual({ printed: 1, noPrint: 0 });
    expect(r.replays[1]!.withStrategy).toMatchObject({ printed: true, matched: 200_000_000n });
    expect(r.summary.buys.orders).toBe(2);
    expect(formatReport(r, 0)).toContain('made 1 cross(es) print that would not have');
    expect(JSON.parse(toJson(r)).summary.strategy).toBe('last-second-bid');
  });

  it('the market-maker strategy is the production bot\'s ladder, snapped to the grid', () => {
    const s = marketMaker({ halfSpreadBps: 200, levels: 2, stepBps: 100, quoteBudget: 400_000_000n, baseBudget: 200_000_000n });
    const orders = s.orders({ cross: synthetic(), book: [], reference: 1_500_000n });
    expect(orders.map((o) => [o.side, o.price])).toEqual([['buy', 1_450_000n], ['sell', 1_550_000n]]);
    expect(s.orders({ cross: synthetic(), book: [], reference: null })).toEqual([]);
    expect(s.orders({ cross: synthetic({ supplyMode: 'mint' }), book: [], reference: 1_500_000n }).every((o) => o.side === 'buy')).toBe(true);
  });
});

describe('loading history', () => {
  it('reads settled crosses from the API, retries a busy endpoint and reports what it could not replay', async () => {
    const f = real.printedEscrow;
    let busy = 1;
    const routes: Record<string, unknown> = {
      '/v1/crosses/summary?limit=1000': { crosses: [{ address: f.address, state: 'Finalized' }, { address: 'LIVE', state: 'Live' }, { address: 'EXT', state: 'Finalized' }, { address: 'GONE', state: 'Finalized' }] },
      [`/v1/crosses/${f.address}/proof`]: f.proof,
      [`/v1/crosses/${f.address}`]: f.detail,
      '/v1/crosses/EXT/proof': { ...f.proof, rules: { allocation: 'lottery' } },
      '/v1/crosses/EXT': f.detail,
    };
    const fetchImpl = (async (input: string) => {
      const path = String(input).replace('https://api.test', '');
      if (path.endsWith('/proof') && path.includes(f.address) && busy-- > 0) return new Response('busy', { status: 429 });
      const body = routes[path];
      return body === undefined ? new Response('no', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await loadFromApi('https://api.test', { fetch: fetchImpl, sleep: async () => undefined });
    expect(out.crosses.map((c) => c.address)).toEqual([f.address]);
    expect(out.skipped.map((s) => [s.address, s.reason.slice(0, 20)])).toEqual([['EXT', 'it uses extended all'], ['GONE', 'could not be read: /']]);
  });
});
