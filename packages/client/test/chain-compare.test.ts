// compareCross: the API's extra, index-derived fields are not mismatches; real differences still are.
import { describe, expect, it } from 'vitest';
import { type CrossDetail, compareCross } from '../src/index.js';

const detail = (over: Partial<CrossDetail> = {}): CrossDetail => ({
  address: 'A', state: 'Finalized', disclosure: 'open', kind: 'launch', supplyMode: 'escrow', creator: 'C', baseMint: 'B', quoteMint: 'Q',
  window: { openTs: '1', closeTs: '2', revealEndTs: '2' }, grid: { minPrice: '1', tick: '1', ticks: 10, priceScale: '1000000' }, decimals: { base: 6, quote: 6 },
  fees: { protocolBps: 0, integratorBps: 0, integrator: 'I' }, orders: { total: 2, open: 0, max: 10 }, clearing: { price: '5', matched: '9', rationed: 'none' },
  noPrintReason: null, gateMint: null, oracleGuard: false, settlement: { settleDeadlineTs: '0', baseBound: true }, ...over,
});

describe('compareCross', () => {
  it('two identical reads match', () => expect(compareCross(detail(), detail())).toEqual({ matches: true, differences: [] }));

  it('the API-only fairness and safety fields are not differences', () => {
    const api = detail({ fairness: { bidders: 2 }, safety: { verdict: 'clear' } });
    expect(compareCross(api, detail())).toEqual({ matches: true, differences: [] });
    expect(compareCross(detail(), api)).toEqual({ matches: true, differences: [] });
  });

  it('a real difference is still reported, and a volatile one is marked', () => {
    const r = compareCross(detail({ fairness: null, creator: 'X', state: 'Cleared' }), detail());
    expect(r.matches).toBe(false);
    expect(r.differences.map((d) => [d.path, d.volatile])).toEqual([['state', true], ['creator', false]]);
  });

  it('does not change its inputs', () => {
    const api = detail({ safety: null });
    compareCross(api, detail());
    expect('safety' in api).toBe(true);
  });
});
