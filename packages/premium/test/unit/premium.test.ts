import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Asset,
  type IssuerState,
  type JupiterQuote,
  type MeasuredAsset,
  type Reference,
  USDC_MINT,
  NoRouteError,
  atomsForNotional,
  collectRound,
  groupObservations,
  impactBpsX100,
  multiplierE12,
  multiplierText,
  parseAssets,
  parseHip3,
  parseQuote,
  percentText,
  perShareE6,
  premiumBpsX100,
  quantileExact,
  sessionOf,
  summarise,
  toE6,
} from '../../src/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;

describe('exact math', () => {
  it('prices a buy per share, rounding up so a payer is never understated', () => {
    // Live Jupiter quote: $10,000 of USDC bought 26.00107809 TSLAx (8 dp, multiplier 1).
    expect(perShareE6('buy', 10_000_000_000n, 2_600_107_809n, 8, multiplierE12(1))).toBe(384_599_438n);
  });

  it('prices a sell per share, rounding down so a receiver is never overstated', () => {
    expect(perShareE6('sell', 383_046_066n, 100_000_000n, 8, multiplierE12(1))).toBe(383_046_066n);
    // 1 / 3 of a micro-USD is dropped on a sell and added on a buy.
    expect(perShareE6('sell', 10n, 3n * 10n ** 7n, 8, multiplierE12(1))).toBe(33n);
    expect(perShareE6('buy', 10n, 3n * 10n ** 7n, 8, multiplierE12(1))).toBe(34n);
  });

  it('turns token atoms into shares through the Scaled UI Amount multiplier', () => {
    // 5 tokens with a 1.001701196801 multiplier are 5.0085 shares: $1,000 / 5.0085 = $199.66 per share.
    expect(perShareE6('buy', 1_000_000_000n, 500_000_000n, 8, multiplierE12(1.001701196801))).toBe(199_660_339n);
  });

  it('carries a multiplier exactly and refuses nonsense', () => {
    expect(multiplierE12(1.001701196801)).toBe(1_001_701_196_801n);
    expect(multiplierText(1_001_701_196_801n)).toBe('1.001701196801');
    expect(multiplierText(multiplierE12(1))).toBe('1');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => multiplierE12(bad)).toThrow();
  });

  it('returns null for a quote that moved no shares', () => {
    expect(perShareE6('buy', 1_000_000n, 0n, 8, multiplierE12(1))).toBeNull();
  });

  it('sizes a sell by notional at the reference price', () => {
    // $1,000 at $250 a share is 4 shares = 4e8 atoms at 8 dp with multiplier 1.
    expect(atomsForNotional(1000, 250_000_000n, 8, multiplierE12(1))).toBe(400_000_000n);
  });

  it('measures the signed distance from a reference in basis points x100', () => {
    expect(premiumBpsX100(384_599_438n, 382_920_000n)).toBe(4_386n); // +43.86 bps, 0.44%
    expect(premiumBpsX100(380_000_000n, 400_000_000n)).toBe(-50_000n); // -500 bps, -5.00%
    expect(premiumBpsX100(400_000_000n, 400_000_000n)).toBe(0n);
  });

  it('formats percents with two decimals and no negative zero', () => {
    expect(percentText(4_386n)).toBe('0.44%');
    expect(percentText(-50_000n)).toBe('-5.00%');
    expect(percentText(-3n)).toBe('0.00%');
    expect(percentText(0n)).toBe('0.00%');
  });
});

describe('sources', () => {
  it('reads a real Jupiter buy quote exactly', () => {
    const q = parseQuote(fixture('jupiter-buy-tslax-10k.json'));
    expect(q.inAmount).toBe(10_000_000_000n);
    expect(q.outAmount).toBe(2_600_107_809n);
    expect(q.routeLabels.length).toBeGreaterThan(0);
    expect(q.priceImpactBpsX100).toBe(impactBpsX100('0.0038453340716658607885052343'));
    expect(impactBpsX100('0.0038453340716658607885052343')).toBe(38n);
  });

  it('turns a not-tradable response into a no-route error', () => {
    expect(() => parseQuote(fixture('jupiter-not-tradable.json'))).toThrow(NoRouteError);
  });

  it('parses a percent impact into basis points x100', () => {
    expect(impactBpsX100('1')).toBe(10_000n);
    expect(impactBpsX100('0')).toBe(0n);
    expect(impactBpsX100('12.3456789')).toBe(123_456n);
    expect(() => impactBpsX100('abc')).toThrow();
  });

  it('reads HIP-3 oracle and mark prices as micro-USD, stamped with the read time', () => {
    const refs = parseHip3(fixture('hip3-xyz-subset.json'), 1_760_000_000);
    const tsla = refs.filter((r) => r.ticker === 'TSLA');
    expect(tsla.map((r) => r.kind).sort()).toEqual(['hip3_mark', 'hip3_oracle']);
    expect(tsla.every((r) => r.priceE6 > 100_000_000n && r.readAt === 1_760_000_000)).toBe(true);
  });

  it('refuses a price with more than six decimals of precision', () => {
    expect(toE6('382.92')).toBe(382_920_000n);
    expect(toE6('0.000001')).toBe(1n);
    expect(() => toE6('1.1234567')).toThrow();
    expect(() => toE6('-1')).toThrow();
  });

  it('reads the issuer clock and halts from the assets API', () => {
    const s = parseAssets([
      { symbol: 'TSLAx', underlyingSymbol: 'tsla', trading: { currentPeriod: 'closed', nextChangeAt: '2026-10-12T00:00:00.000Z', isTradingHalted: false }, deployments: [{ network: 'Solana', address: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' }] },
      { symbol: 'XXXx', underlyingSymbol: 'XXX', isTradingHalted: true, trading: null, deployments: [] },
      { symbol: 'NOPEx', underlyingSymbol: null, trading: null, deployments: [] },
    ]);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ ticker: 'TSLA', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', halted: false, period: 'closed', nextChangeAt: 1_791_763_200 });
    expect(s[1]).toMatchObject({ halted: true, period: null, mint: null });
  });
});

describe('sessions', () => {
  it('maps the issuer period, splitting extended hours by the New York hour', () => {
    const preMarket = Date.parse('2026-10-14T12:00:00Z') / 1000; // 08:00 EDT
    const postMarket = Date.parse('2026-10-14T21:00:00Z') / 1000; // 17:00 EDT
    expect(sessionOf('market', preMarket)).toBe('regular');
    expect(sessionOf('extended', preMarket)).toBe('pre');
    expect(sessionOf('extended', postMarket)).toBe('post');
    expect(sessionOf('overnight', postMarket)).toBe('overnight');
    expect(sessionOf('closed', postMarket)).toBe('closed');
    expect(sessionOf('something-new', postMarket)).toBeNull();
  });
});

describe('statistics', () => {
  it('reports only premiums that were quoted, by index floor(n x q)', () => {
    const s = summarise([5n, -3n, 1n, 9n, -7n, 2n]);
    expect(s).toMatchObject({ n: 6, minBpsX100: -7n, maxBpsX100: 9n, medianBpsX100: 2n, p10BpsX100: -7n, p90BpsX100: 9n });
    expect(s.medianAbsBpsX100).toBe(5n);
    expect(quantileExact([], 0.5)).toBeNull();
    expect(summarise([]).n).toBe(0);
  });
});

describe('collectRound', () => {
  const asset: MeasuredAsset = { ticker: 'TSLA', symbol: 'TSLAx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, multiplierE12: multiplierE12(1) };
  const ref: Reference = { kind: 'hip3_oracle', ticker: 'TSLA', priceE6: 382_920_000n, readAt: 1_000 };
  const state: IssuerState = { ticker: 'TSLA', symbol: 'TSLAx', mint: asset.mint, halted: false, period: 'market', nextChangeAt: null };
  const quote = async (inMint: string, outMint: string, amount: bigint): Promise<JupiterQuote> => {
    // A venue that sells at $383.00 a share and buys at $382.50.
    if (inMint === USDC_MINT) return { inputMint: inMint, outputMint: outMint, inAmount: amount, outAmount: (amount * 10n ** 8n * 100n) / 38_300_000_000n / 1n, priceImpactBpsX100: 12n, routeLabels: ['Raydium CLMM'], contextSlot: 1 };
    return { inputMint: inMint, outputMint: outMint, inAmount: amount, outAmount: (amount * 38_250_000_000n) / 10n ** 8n / 100n, priceImpactBpsX100: 9n, routeLabels: ['BinaryFi'], contextSlot: 1 };
  };
  const base = { quote, now: 1_760_000_000, sizesUsd: [1000, 10000], referenceKind: 'hip3_oracle' as const, references: new Map([['TSLA', ref]]), issuer: new Map([['TSLA', state]]) };

  it('prices each size and leg against the reference and reports the signed premium', async () => {
    const obs = await collectRound([asset], base);
    expect(obs).toHaveLength(4);
    const buy = obs.find((o) => o.leg === 'buy' && o.sizeUsd === 1000)!;
    expect(buy.status).toBe('ok');
    expect(buy.session).toBe('regular');
    expect(buy.perShareE6).toBeGreaterThan(382_990_000n);
    expect(buy.perShareE6).toBeLessThan(383_010_000n);
    expect(buy.premiumBpsX100).toBeGreaterThan(0n);
    const sell = obs.find((o) => o.leg === 'sell' && o.sizeUsd === 1000)!;
    expect(sell.premiumBpsX100).toBeLessThan(0n);
    expect(sell.route).toBe('BinaryFi');
    expect(buy.multiplier).toBe('1');
  });

  it('records why an attempt could not be priced instead of dropping it', async () => {
    const cases: [string, Partial<typeof base> & { asset?: MeasuredAsset }, string][] = [
      ['no reference', { references: new Map() }, 'no_reference'],
      ['issuer halted', { issuer: new Map([['TSLA', { ...state, halted: true }]]) }, 'issuer_halted'],
      ['no multiplier', { asset: { ...asset, multiplierE12: null } }, 'no_multiplier'],
      ['no route', { quote: async () => { throw new NoRouteError('none'); } }, 'no_route'],
      ['quote failed', { quote: async () => { throw new Error('HTTP 500'); } }, 'quote_failed'],
    ];
    for (const [name, patch, status] of cases) {
      const { asset: a, ...rest } = patch;
      const obs = await collectRound([a ?? asset], { ...base, ...rest });
      expect(obs.length, name).toBe(4);
      expect(obs.every((o) => o.status === status && o.premiumBpsX100 === null), name).toBe(true);
    }
  });

  it('measures nothing under a guessed session when the issuer clock is unknown', async () => {
    expect(await collectRound([asset], { ...base, issuer: new Map() })).toEqual([]);
    expect(await collectRound([asset], { ...base, issuer: new Map([['TSLA', { ...state, period: 'weekend-special' }]]) })).toEqual([]);
  });

  it('groups by session, size and leg, counting exclusions beside the numbers', async () => {
    const ok = await collectRound([asset], base);
    const closed = await collectRound([asset], { ...base, references: new Map() });
    const groups = groupObservations([...ok, ...closed]);
    const g = groups.find((x) => x.leg === 'buy' && x.sizeUsd === 1000)!;
    expect(g.summary.n).toBe(1);
    expect(g.excluded).toEqual({ no_reference: 1 });
  });
});

describe('types stay honest', () => {
  it('has the asset shape the universe builder returns', () => {
    const a: Asset = { ticker: 'X', symbol: 'Xx', mint: 'm', decimals: 8 };
    expect(a.decimals).toBe(8);
  });
});
