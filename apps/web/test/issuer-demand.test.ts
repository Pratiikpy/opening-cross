import { describe, expect, it } from 'vitest';
import type { DemandMap } from '../src/lib/issuer-board';
import { demandRows } from '../src/lib/issuer-board';
import { pctOf, sizing } from '../src/lib/issuer-demand';

const map = (levels: DemandMap['levels'], offered = '300'): DemandMap => ({
  id: 'a'.repeat(64),
  status: 'not-verified',
  signer: 'S',
  issuedAt: 1,
  draft: { title: 'T', summary: 's', baseMint: null, quoteMint: null, baseDecimals: 6, quoteDecimals: 6, minPrice: '1.00', tick: '0.10', ticks: 10, offered, supplyMode: 'mint' },
  grid: { minPrice: '1000000', tick: '100000', ticks: 10, quoteDecimals: 6, baseDecimals: 6 },
  commits: { wallets: levels.reduce((a, l) => a + l.wallets, 0), totalBudget: '0', totalTokens: '0' },
  levels,
  byTrackRecord: { 'filled-before': { wallets: 0, tokens: '0' }, 'bid-before': { wallets: 0, tokens: '0' }, 'no-history': { wallets: 0, tokens: '0' } },
  notCollected: ['region', 'identity'],
  note: '',
});
const L = (price: number, tokens: number, wallets = 1) => ({ index: 0, price: String(price * 1_000_000), tokens: String(tokens * 1_000_000), budget: String(Math.round(price * tokens * 1_000_000)), wallets });

describe('sizing', () => {
  it('accumulates demand from the highest price down and reports how much of the offer each covers', () => {
    const s = sizing(map([L(1.2, 100), L(1.5, 100), L(1.8, 50, 2)]));
    expect(s.rows.map((r) => [String(r.price), String(r.tokensAtOrAbove), r.wallets])).toEqual([['1800000', '50000000', 2], ['1500000', '150000000', 3], ['1200000', '250000000', 4]]);
    expect(s.rows[2]!.coverageBps).toBe(8333n);
    expect(s.coverPrice).toBeNull(); // 250 of 300 at best
  });
  it('finds the highest price at which the whole offer is still covered, and the raise there', () => {
    const s = sizing(map([L(1.2, 200), L(1.5, 150)]));
    expect(s.coverPrice).toEqual({ price: 1_200_000n, raise: 360_000_000n }); // 300 tokens at 1.20
    const s2 = sizing(map([L(1.2, 200), L(1.5, 300)]));
    expect(s2.coverPrice).toEqual({ price: 1_500_000n, raise: 450_000_000n });
  });
  it('is empty with no commits', () => {
    const s = sizing(map([]));
    expect(s.rows).toEqual([]);
    expect(s.coverPrice).toBeNull();
  });
  it('an offer of zero or unreadable has no coverage', () => {
    expect(sizing(map([L(1.2, 5)], '0')).rows[0]!.coverageBps).toBeNull();
  });
});

describe('pctOf and demandRows', () => {
  it('formats a share of the offer', () => {
    expect(pctOf(8333n)).toBe('83.3%');
    expect(pctOf(10_000n)).toBe('100%');
    expect(pctOf(null)).toBe('unknown');
  });
  it('turns levels into simulator rows exactly, and refuses a draft whose decimals differ', () => {
    const rows = demandRows(map([L(1.2, 100), L(1.5, 60)]), 6, 6);
    expect(rows).toEqual([{ price: '1.2', quantity: '100' }, { price: '1.5', quantity: '60' }]);
    expect(demandRows(map([L(1.2, 1)]), 9, 6)).toMatch(/cannot be used here/);
    expect(demandRows(map([L(1.2, 1)]), null, null)).toMatch(/Check both tokens first/);
  });
});
