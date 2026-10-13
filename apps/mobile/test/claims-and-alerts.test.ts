import { describe, expect, it } from 'vitest';
import { targetOf, when } from '../src/lib/alerts';
import { candidates, claimBody, scanClaims } from '../src/lib/claims';
import type { CrossDetail, OwnerOrder } from '../src/lib/types';

const order = (over: Partial<OwnerOrder> & { address: string; cross_address: string }): OwnerOrder => ({ idx: 0, side: 'buy', escrow: '3600000', sealed: false, price: null, quantity: null, status: 'revealed', fill: null, quote_out: null, base_out: null, fee: null, ...over });
const cross = (address: string, state: CrossDetail['state']): CrossDetail => ({
  address,
  state,
  disclosure: 'open',
  kind: 'launch',
  supplyMode: 'escrow',
  creator: 'c',
  baseMint: 'b',
  quoteMint: 'q',
  window: { openTs: '1', closeTs: '2', revealEndTs: '2' },
  grid: { minPrice: '1', tick: '1', ticks: 2, priceScale: '1000000' },
  decimals: { base: 6, quote: 6 },
  fees: { protocolBps: 0, integratorBps: 0, integrator: 'i' },
  orders: { total: 0, open: 0, max: 1 },
  clearing: null,
  noPrintReason: null,
  gateMint: null,
  oracleGuard: false,
  settlement: { settleDeadlineTs: '0', baseBound: true },
});

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe('claim candidates', () => {
  it('keeps open orders in settled crosses only', () => {
    const rows = [
      order({ address: 'o1', cross_address: 'c1' }),
      order({ address: 'o2', cross_address: 'c2', status: 'claimed' }),
      order({ address: 'o3', cross_address: 'c3' }),
      order({ address: 'o4', cross_address: 'c4', status: 'cancelled' }),
      order({ address: 'o5', cross_address: 'c5', status: 'committed' }),
      order({ address: 'o6', cross_address: 'missing' }),
    ];
    const crosses = new Map([['c1', cross('c1', 'Cleared')], ['c2', cross('c2', 'Cleared')], ['c3', cross('c3', 'Live')], ['c4', cross('c4', 'NoPrint')], ['c5', cross('c5', 'NoPrint')]]);
    expect(candidates(rows, crosses).map((c) => c.order.address)).toEqual(['o1', 'o5']);
  });
});

describe('scanClaims', () => {
  const owner = 'Owner1111111111111111111111111111111111111';
  const serve = (routes: Record<string, () => Response>) =>
    (async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) throw new Error(`unexpected ${url}`);
      return hit[1]();
    }) as unknown as typeof fetch;

  it('offers the orders the chain still holds, with the nonce the claim needs', async () => {
    const f = serve({
      '/v1/owners': () => json({ orders: [order({ address: 'o1', cross_address: 'c1' }), order({ address: 'o2', cross_address: 'c1', side: 'sell' })] }),
      '/v1/crosses/c1': () => json(cross('c1', 'Cleared')),
      '/v1/orders?addresses=': () => json({ orders: [{ address: 'o1', found: true, open: true, nonce: 7 }, { address: 'o2', found: true, open: false }] }),
    });
    const r = await scanClaims(owner, f, 'http://api');
    expect(r.failed).toBe(false);
    expect(r.checked).toBe(true);
    expect(r.claimable.map((c) => [c.order.address, c.nonce, c.kind])).toEqual([['o1', '7', 'cleared']]);
    expect(claimBody(r.claimable[0]!, owner)).toEqual({ cross: 'c1', owner, nonce: '7', payer: owner });
  });

  it('labels a no-print refund, and says so when the chain could not be read', async () => {
    const f = serve({
      '/v1/owners': () => json({ orders: [order({ address: 'o1', cross_address: 'c1' })] }),
      '/v1/crosses/c1': () => json(cross('c1', 'NoPrint')),
      '/v1/orders?addresses=': () => new Response('down', { status: 503 }),
    });
    const r = await scanClaims(owner, f, 'http://api');
    expect(r.claimable).toEqual([]);
    expect(r.checked).toBe(false);
    const ok = serve({
      '/v1/owners': () => json({ orders: [order({ address: 'o1', cross_address: 'c1' })] }),
      '/v1/crosses/c1': () => json(cross('c1', 'NoPrint')),
      '/v1/orders?addresses=': () => json({ orders: [{ address: 'o1', found: true, open: true, nonce: '3' }] }),
    });
    expect((await scanClaims(owner, ok, 'http://api')).claimable[0]!.kind).toBe('no-print');
  });

  it('reports a failure when the index cannot be reached, and a cross it cannot read as unchecked', async () => {
    expect((await scanClaims(owner, serve({ '/v1/owners': () => new Response('x', { status: 500 }) }), 'http://api')).failed).toBe(true);
    const f = serve({ '/v1/owners': () => json({ orders: [order({ address: 'o1', cross_address: 'c1' })] }), '/v1/crosses/c1': () => new Response('x', { status: 404 }) });
    const r = await scanClaims(owner, f, 'http://api');
    expect(r.checked).toBe(false);
    expect(r.claimable).toEqual([]);
  });
});

describe('alert feed helpers', () => {
  it('sends a cross link to its screen and anything else to the orders screen', () => {
    expect(targetOf('/crosses/ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8')).toEqual({ screen: 'Cross', address: 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8' });
    expect(targetOf('/orders')).toEqual({ screen: 'Orders' });
    expect(targetOf('/crosses/../../etc')).toEqual({ screen: 'Orders' });
  });
  it('says how far away an event is', () => {
    expect(when(0, 100)).toBe('now');
    expect(when(100, 100)).toBe('now');
    expect(when(140, 100)).toBe('in under a minute');
    expect(when(100 + 540, 100)).toBe('in 9 min');
    expect(when(100 + 7200, 100)).toBe('in 2 h');
    expect(when(100 + 3 * 86_400, 100)).toBe('in 3 days');
  });
});

import { badgeOf } from '../src/lib/listing';

describe('crosses list badge', () => {
  const c = (state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized') => ({ state, open_ts: '1000', close_ts: '2000' });
  it('calls a live cross open only between its open and close, and not open before or after', () => {
    expect(badgeOf(c('Live'), 999)).toEqual({ label: 'Opens soon', tone: 'plain' });
    expect(badgeOf(c('Live'), 1000)).toEqual({ label: 'Open', tone: 'live' });
    expect(badgeOf(c('Live'), 1999)).toEqual({ label: 'Open', tone: 'live' });
    expect(badgeOf(c('Live'), 2000)).toEqual({ label: 'Awaiting settlement', tone: 'plain' });
  });
  it('reports a settled cross by its state whatever the clock says', () => {
    expect(badgeOf(c('Cleared'), 500).label).toBe('Cleared');
    expect(badgeOf(c('NoPrint'), 5000).label).toBe('No print');
    expect(badgeOf(c('Finalized'), 5000).label).toBe('Finalized');
  });
});
