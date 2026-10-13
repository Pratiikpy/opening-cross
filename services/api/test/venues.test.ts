// Venue ranking for /v1/router/quote: pure, no network.
import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import type { CrossQuote, DexQuote } from '@opening-cross/router';
import { METEORA_EXCLUSION, rankVenues } from '../src/venues.js';

const A = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;
const B = '22eBxH5mXpFk3NboAgReTkeNwvgerdKAeNWsrNmDy8Ta' as Address;

const open = (cross: Address, fill: bigint, quote: bigint, feeBps = 0): CrossQuote => ({
  venue: 'cross', cross, available: true, disclosure: 'open', closeTs: 100n, indicative: { prints: true, price: 1n, fill, quote }, feeBps,
});
const jup = (base: bigint, quote: bigint): DexQuote => ({ venue: 'jupiter', available: true, quote, base, contextSlot: 7n, route: ['Meteora DAMM v2'], priceImpactPct: '0.01' });
const skipped = { skipped: 'no dex' };

describe('rankVenues', () => {
  it('a buyer ranks the lower price first and prices per whole base token (6 decimals)', () => {
    // Cross: 2 base for 3.0 quote -> 1.5 per base. Jupiter: 2 base for 3.2 quote -> 1.6.
    const r = rankVenues({ side: 'buy', amount: 2_000_000n, baseDecimals: 6, crosses: [open(A, 2_000_000n, 3_000_000n)], dex: jup(2_000_000n, 3_200_000n) });
    expect(r.venues.map((v) => [v.rank, v.venue, v.pricePerBase, v.fill])).toEqual([
      [1, 'cross', 1_500_000n, 'full'],
      [2, 'jupiter', 1_600_000n, 'full'],
    ]);
    expect(r.best).toEqual({ venue: 'cross', cross: A });
  });

  it('a seller ranks the higher price first', () => {
    const r = rankVenues({ side: 'sell', amount: 2_000_000n, baseDecimals: 6, crosses: [open(A, 2_000_000n, 3_000_000n)], dex: jup(2_000_000n, 3_200_000n) });
    expect(r.venues.map((v) => v.venue)).toEqual(['jupiter', 'cross']);
    expect(r.best).toEqual({ venue: 'jupiter' });
  });

  it('rounds against the trader: buyers up, sellers down', () => {
    const buy = rankVenues({ side: 'buy', amount: 3n, baseDecimals: 0, crosses: [open(A, 3n, 10n)], dex: skipped });
    expect(buy.venues[0]!.pricePerBase).toBe(4n); // ceil(10 / 3)
    const sell = rankVenues({ side: 'sell', amount: 3n, baseDecimals: 0, crosses: [open(A, 3n, 10n)], dex: skipped });
    expect(sell.venues[0]!.pricePerBase).toBe(3n); // floor(10 / 3)
  });

  it('a full fill beats a better price on a partial fill; partials sort by size', () => {
    const r = rankVenues({
      side: 'buy', amount: 10n, baseDecimals: 0,
      crosses: [open(A, 2n, 2n), open(B, 6n, 12n)],
      dex: jup(10n, 30n),
    });
    expect(r.venues.map((v) => [v.venue, v.fill])).toEqual([['jupiter', 'full'], ['cross', 'partial'], ['cross', 'partial']]);
    expect(r.venues[1]).toMatchObject({ cross: B, baseAtoms: 6n });
    expect(r.caveats.join(' ')).toMatch(/partial/);
  });

  it('every exclusion carries its reason: unavailable, sealed, no print, DEX failure, and Meteora is never priced', () => {
    const r = rankVenues({
      side: 'buy', amount: 5n, baseDecimals: 0,
      crosses: [
        { venue: 'cross', cross: A, available: false, reason: 'call period has closed' },
        { venue: 'cross', cross: B, available: true, disclosure: 'sealed', closeTs: 9n, indicative: null, feeBps: 0 },
        { venue: 'cross', cross: 'Sysvar1111111111111111111111111111111111111' as Address, available: true, disclosure: 'open', closeTs: 9n, indicative: { prints: false, price: null, fill: 0n, quote: 0n }, feeBps: 0 },
      ],
      dex: { venue: 'jupiter', available: false, reason: 'Jupiter answered HTTP 400: COULD_NOT_FIND_ANY_ROUTE' },
    });
    expect(r.venues).toEqual([]);
    expect(r.best).toBeNull();
    expect(r.excluded.map((e) => [e.venue, e.reason])).toEqual([
      ['cross', 'call period has closed'],
      ['cross', expect.stringMatching(/Sealed cross/)],
      ['cross', expect.stringMatching(/would not trade/)],
      ['jupiter', expect.stringMatching(/COULD_NOT_FIND_ANY_ROUTE/)],
      ['meteora', METEORA_EXCLUSION],
    ]);
  });

  it('no live cross and no DEX: both are explained', () => {
    const r = rankVenues({ side: 'sell', amount: 5n, baseDecimals: 6, crosses: [], dex: skipped });
    expect(r.excluded.map((e) => e.reason)).toEqual(['No live cross trades this pair.', 'no dex', METEORA_EXCLUSION]);
    expect(r.venues).toEqual([]);
  });

  it('equal prices break the tie deterministically', () => {
    const one = rankVenues({ side: 'buy', amount: 1n, baseDecimals: 0, crosses: [open(B, 1n, 5n), open(A, 1n, 5n)], dex: jup(1n, 5n) });
    const two = rankVenues({ side: 'buy', amount: 1n, baseDecimals: 0, crosses: [open(A, 1n, 5n), open(B, 1n, 5n)], dex: jup(1n, 5n) });
    expect(one.venues.map((v) => v.venue === 'cross' ? v.cross : 'jupiter')).toEqual(two.venues.map((v) => v.venue === 'cross' ? v.cross : 'jupiter'));
  });

  it('marks cross prices as indicative and not executable now, and Jupiter as executable now', () => {
    const r = rankVenues({ side: 'buy', amount: 1n, baseDecimals: 0, crosses: [open(A, 1n, 5n)], dex: jup(1n, 6n) });
    expect(r.venues.find((v) => v.venue === 'cross')).toMatchObject({ indicative: true, executableNow: false });
    expect(r.venues.find((v) => v.venue === 'jupiter')).toMatchObject({ executableNow: true, route: ['Meteora DAMM v2'] });
  });
});
