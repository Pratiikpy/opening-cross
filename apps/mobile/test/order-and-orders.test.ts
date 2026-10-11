import { describe, expect, it } from 'vitest';
import { check, marketOf, onGrid, phaseOf, placeOrderBody } from '../src/lib/order';
import { toView } from '../src/lib/orders';
import { explainCalibration } from '../src/lib/reasons';
import { type KeyValue, exportBackup, importBackup, loadBids, nonceFrom, rememberOrder, rememberedOrders, saltFrom, saveBid } from '../src/lib/sealed';
import type { CrossDetail } from '../src/lib/types';

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v) };
};

const cross: CrossDetail = {
  address: 'CrossAddress1111111111111111111111111111111',
  state: 'Live',
  disclosure: 'open',
  kind: 'launch',
  supplyMode: 'escrow',
  creator: 'c',
  baseMint: 'b',
  quoteMint: 'q',
  window: { openTs: '1000', closeTs: '2000', revealEndTs: '3000' },
  grid: { minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000' },
  decimals: { base: 6, quote: 6 },
  fees: { protocolBps: 5, integratorBps: 20, integrator: 'i' },
  orders: { total: 0, open: 0, max: 64 },
  clearing: null,
  noPrintReason: null,
  gateMint: null,
  oracleGuard: false,
  settlement: { settleDeadlineTs: '0', baseBound: true },
};

describe('order entry', () => {
  const m = marketOf(cross);

  it('accepts only prices on the grid and says what would work', () => {
    expect(onGrid('1.2', cross, m)).toBe(1_200_000n);
    expect(onGrid('1.25', cross, m)).toMatch(/steps of 0\.1\. Try 1\.2 or 1\.3/);
    expect(onGrid('0.5', cross, m)).toMatch(/must be between 1 and 2\.9/);
    expect(onGrid('3', cross, m)).toMatch(/must be between/);
    expect(onGrid('abc', cross, m)).toMatch(/Enter a price/);
  });

  it('computes the escrow the program will hold, rounding a buyer up', () => {
    const c = check({ side: 'buy', priceText: '1.2', qtyText: '10' }, cross);
    expect(c).toMatchObject({ ok: true, price: 1_200_000n, quantity: 10_000_000n, escrow: 12_000_000n, escrowText: '12' });
    const s = check({ side: 'sell', priceText: '1.2', qtyText: '10' }, cross);
    expect(s).toMatchObject({ ok: true, escrow: 10_000_000n, escrowText: '10' });
    const odd = check({ side: 'buy', priceText: '1.1', qtyText: '0.000003' }, cross);
    expect(odd).toMatchObject({ ok: true, escrow: 4n }); // 3 x 1.1 = 3.3, charged as 4 atoms
  });

  it('holds back an order until both fields are valid', () => {
    expect(check({ side: 'buy', priceText: '', qtyText: '' }, cross)).toMatchObject({ ok: false, priceError: null, qtyError: null });
    expect(check({ side: 'buy', priceText: '1.2', qtyText: '0' }, cross)).toMatchObject({ ok: false, qtyError: expect.stringContaining('amount of tokens') });
    expect(check({ side: 'buy', priceText: '1.2', qtyText: '1.0000001' }, cross)).toMatchObject({ ok: false });
    expect(check({ side: 'buy', priceText: '9', qtyText: '1' }, cross)).toMatchObject({ ok: false, priceError: expect.any(String) });
  });

  it('builds the exact body the API expects, integers as decimal strings', () => {
    const body = placeOrderBody(cross, 'Owner', { side: 'buy', priceText: '', qtyText: '', price: 1_200_000n, quantity: 10_000_000n }, '123', 'ab'.repeat(32));
    expect(body).toEqual({ cross: cross.address, owner: 'Owner', side: 'buy', price: '1200000', quantity: '10000000', nonce: '123', salt: 'ab'.repeat(32) });
    expect(placeOrderBody(cross, 'Owner', { side: 'sell', priceText: '', qtyText: '', price: 1n, quantity: 1n }, '1')).not.toHaveProperty('salt');
  });

  it('knows which phase a cross is in', () => {
    expect(phaseOf(cross, 999n)).toBe('upcoming');
    expect(phaseOf(cross, 1500n)).toBe('open');
    expect(phaseOf(cross, 2000n)).toBe('awaiting-settlement');
    expect(phaseOf({ ...cross, disclosure: 'sealed' }, 2500n)).toBe('reveal');
    expect(phaseOf({ ...cross, disclosure: 'sealed' }, 3000n)).toBe('awaiting-settlement');
    expect(phaseOf({ ...cross, state: 'Cleared' }, 1n)).toBe('settled');
  });
});

describe('sealed bids kept on the device', () => {
  const bid = { cross: 'c', owner: 'o', nonce: '1', side: 'buy' as const, price: '1200000', quantity: '5', salt: 'aa', placedAt: 't' };

  it('stores, replaces by nonce and backs up', async () => {
    const s = memory();
    expect(await saveBid(s, bid)).toBe(true);
    expect(await saveBid(s, { ...bid, price: '1300000' })).toBe(true);
    expect(await saveBid(s, { ...bid, nonce: '2' })).toBe(true);
    const all = await loadBids(s, 'c', 'o');
    expect(all.map((b) => [b.nonce, b.price])).toEqual([['1', '1300000'], ['2', '1200000']]);
    const backup = exportBackup(all);
    const fresh = memory();
    expect(await importBackup(fresh, backup, 'c', 'o')).toBe(2);
    expect(await importBackup(fresh, backup, 'c', 'someone-else')).toBe(0);
    await expect(importBackup(fresh, '{"schema":"other"}', 'c', 'o')).rejects.toThrow('not an Opening Bell sealed-bid backup');
  });

  it('reports a failed write so the order is not sent without its salt', async () => {
    const broken: KeyValue = { getItem: async () => null, setItem: async () => { throw new Error('disk full'); } };
    expect(await saveBid(broken, bid)).toBe(false);
  });

  it('draws nonces and salts from the supplied random source', () => {
    expect(saltFrom((n) => new Uint8Array(n).fill(255))).toBe('ff'.repeat(32));
    expect(nonceFrom(() => Uint8Array.from([0, 0, 0, 0, 1, 0]))).toBe('256');
    expect(nonceFrom(() => new Uint8Array(6).fill(255))).toBe(String(2 ** 48 - 1));
  });

  it('remembers orders placed from this device', async () => {
    const s = memory();
    await rememberOrder(s, 'c', 'o', 'A');
    await rememberOrder(s, 'c', 'o', 'B');
    await rememberOrder(s, 'c', 'o', 'A');
    expect(await rememberedOrders(s, 'c', 'o')).toEqual(['A', 'B']);
    expect(await rememberedOrders(s, 'c', 'nobody')).toEqual([]);
  });
});

describe('order views and calibration text', () => {
  it('reads an open order from chain and a closed one from the index, and drops unknowns', () => {
    expect(toView({ address: 'a', found: false })).toBeNull();
    expect(toView({ address: 'a', found: true, open: true, side: 'buy', nonce: '7', revealed: true, escrow: '5' })).toMatchObject({ open: true, nonce: '7', revealed: true, escrow: '5' });
    expect(toView({ address: 'b', found: true, open: false, side: 'sell', status: 'claimed', escrow: '9', price: '1', quantity: '2' })).toMatchObject({ open: false, nonce: null, revealed: true, status: 'claimed' });
    expect(toView({ address: 'c', found: true, open: false, side: 'sell', status: 'committed', escrow: '9' })?.revealed).toBe(false);
  });

  it('explains why a band claims no coverage', () => {
    expect(explainCalibration('SAMPLES 3<30')).toBe('A band claims a coverage only once enough crosses have been graded: 3 of the 30 graded crosses needed.');
    expect(explainCalibration(null)).toBeNull();
  });
});
