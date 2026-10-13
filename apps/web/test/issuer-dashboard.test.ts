import { describe, expect, it } from 'vitest';
import type { CrossRow, TreasuryRow } from '../src/lib/issuer-data';
import { type OrderRow, feesPaid, holderRegister, ownCrosses, registerCsv, tasks } from '../src/lib/issuer-dashboard';

const cross = (o: Partial<CrossRow> = {}): CrossRow => ({ address: 'C1', state: 'Finalized', disclosure: 'open', supplyMode: 'mint', orders: 3, openTs: '100', closeTs: '200', revealEndTs: '200', creator: 'ME', baseMint: 'COIN', quoteMint: 'Q', clearingPrice: '1200000', matched: '600000000', ...o });
const order = (o: Partial<OrderRow> = {}): OrderRow => ({ idx: 0, address: 'o', owner: 'A', side: 'buy', escrow: '780000000', sealed: false, price: '1300000', quantity: '600000000', status: 'claimed', fill: '600000000', quote_out: '60000000', base_out: '600000000', fee: '0', ...o });
const treasury = (o: Partial<TreasuryRow> = {}): TreasuryRow => ({ address: 'TREAS', coinMint: 'COIN', authority: 'ME', chain: 'read', state: 'Active', disclosure: { state: 'current', basis: 'last-update', basisAt: 1, note: '', updateCount: 1, overdueAt: null, requestedAt: null }, ...o });

describe('ownCrosses', () => {
  it('keeps only the wallet’s crosses, newest window first', () => {
    const rows = [cross({ address: 'a', openTs: '100' }), cross({ address: 'b', openTs: '300' }), cross({ address: 'c', creator: 'OTHER', openTs: '999' })];
    expect(ownCrosses(rows, 'ME').map((c) => c.address)).toEqual(['b', 'a']);
    expect(ownCrosses(rows, 'NOBODY')).toEqual([]);
  });
});

describe('holder register', () => {
  const orders = [order({ owner: 'A' }), order({ idx: 1, owner: 'B', fill: '0', quote_out: '780000000', base_out: '0' }), order({ idx: 2, owner: 'A', escrow: '100000000', fill: '50000000', quote_out: '40000000' }), order({ idx: 3, owner: 'S', side: 'sell' })];
  it('sums a wallet’s orders, leaves out sellers, and sorts by what each received', () => {
    const r = holderRegister(orders, true);
    expect(r.map((h) => h.owner)).toEqual(['A', 'B']);
    expect(r[0]).toMatchObject({ owner: 'A', orders: 2, filled: 650_000_000n, escrow: 880_000_000n, spent: 780_000_000n, status: 'received' });
    expect(r[1]).toMatchObject({ owner: 'B', filled: 0n, status: 'refunded', spent: 0n });
  });
  it('before settlement nobody has received anything', () => {
    const r = holderRegister(orders, false);
    expect(r.every((h) => h.status === 'pending' && h.filled === 0n)).toBe(true);
    expect(r[0]!.escrow).toBe(880_000_000n);
  });
  it('is empty with no orders', () => {
    expect(holderRegister([], true)).toEqual([]);
  });
  it('exports a CSV with units, quoting what needs quoting', () => {
    const csv = registerCsv(holderRegister(orders, true), 6, 6);
    expect(csv.split('\n')[0]).toBe('wallet,orders,tokens_received,quote_escrowed,status');
    expect(csv).toContain('A,2,650,880,received');
    expect(csv).toContain('B,1,0,780,refunded');
    expect(registerCsv([{ owner: 'a,"b"', orders: 1, filled: 0n, escrow: 0n, spent: 0n, status: 'pending' }], 6, 6)).toContain('"a,""b"""');
  });
});

describe('feesPaid', () => {
  const c = { clearing: { price: '1200000', matched: '600000000' }, fees: { protocolBps: 5, integratorBps: 20 }, grid: { priceScale: '1000000' } };
  it('is the program’s formula: notional rounded up, total from basis points, protocol’s share of the total', () => {
    expect(feesPaid(c)).toEqual({ notional: 720_000_000n, total: 1_800_000n, protocol: 360_000n, integrator: 1_440_000n });
  });
  it('is zero without an integrator fee and null without a print', () => {
    expect(feesPaid({ ...c, fees: { protocolBps: 0, integratorBps: 0 } })).toMatchObject({ total: 0n, protocol: 0n, integrator: 0n });
    expect(feesPaid({ ...c, clearing: null })).toBeNull();
  });
});

describe('tasks', () => {
  const base = { wallet: 'ME', crosses: [] as CrossRow[], treasuries: [] as TreasuryRow[], questions: { requested: 0, overdue: 0 }, nowSecs: 150 };
  it('has nothing to say when there is nothing to do', () => {
    expect(tasks(base)).toEqual([]);
  });
  it('offers a treasury only for a launched coin that has none, once per coin', () => {
    const crosses = [cross({ address: 'a' }), cross({ address: 'b' }), cross({ address: 'c', baseMint: 'OTHER', creator: 'NOT-ME' })];
    const t = tasks({ ...base, crosses });
    expect(t.map((x) => x.id)).toEqual(['treasury-COIN']);
    expect(t[0]!.href).toBe('/issuer/treasury/new?coin=COIN');
    expect(tasks({ ...base, crosses, treasuries: [treasury()] })).toEqual([]);
    expect(tasks({ ...base, crosses: [cross({ supplyMode: 'escrow' })] })).toEqual([]);
    expect(tasks({ ...base, crosses: [cross({ clearingPrice: null, matched: null, state: 'NoPrint' })] })).toEqual([]);
  });
  it('puts overdue disclosure and overdue questions before everything else', () => {
    const t = tasks({ ...base, crosses: [cross()], treasuries: [treasury({ disclosure: { state: 'overdue', basis: 'creation', basisAt: 1, note: 'It is late.', updateCount: 0, overdueAt: 1, requestedAt: 1 } })], questions: { requested: 2, overdue: 1 } });
    expect(t.map((x) => x.id)).toEqual(['update-TREAS', 'qa-overdue', 'qa-requested']);
    expect(t[0]!.tone).toBe('now');
  });
  it('a lapsed attestation is urgent, and only on the issuer’s own treasuries', () => {
    expect(tasks({ ...base, treasuries: [treasury({ lapsedSince: '10' })] }).map((x) => x.id)).toEqual(['lapse-TREAS']);
    expect(tasks({ ...base, treasuries: [treasury({ lapsedSince: '10', authority: 'OTHER' })] })).toEqual([]);
  });
  it('says when a cross has not opened and when it is taking orders, by the clock', () => {
    const live = cross({ state: 'Live', openTs: '200', closeTs: '300', revealEndTs: '300', clearingPrice: null, matched: null });
    expect(tasks({ ...base, crosses: [live], nowSecs: 140 })[0]).toMatchObject({ id: 'opens-C1' });
    expect(tasks({ ...base, crosses: [live], nowSecs: 250 })[0]).toMatchObject({ id: 'live-C1' });
    expect(tasks({ ...base, crosses: [live], nowSecs: 400 })).toEqual([]);
  });
});
