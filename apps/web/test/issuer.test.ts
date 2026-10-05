import { describe, expect, it } from 'vitest';
import { type IssuerForm, checkIssuerForm } from '../src/lib/issuer';

const now = new Date('2026-10-05T12:00:00Z');
const base: IssuerForm = {
  creator: 'C', baseMint: 'B', quoteMint: 'Q', baseDecimals: 6, quoteDecimals: 6, baseTokenProgram: 'T', quoteTokenProgram: 'T',
  disclosure: 'sealed', supplyMode: 'mint', kind: 'launch', minPrice: '1.00', tick: '0.05', ticks: 40,
  openAt: new Date('2026-10-05T13:00:00Z'), closeAt: new Date('2026-10-05T15:00:00Z'), revealMinutes: 30,
  minMatched: '100', maxImbalancePct: '', integrator: 'I', integratorFeeBps: 20, maxOrders: 1000, shards: 4, proceedsTo: 'P',
  schedule: [{ price: '1.20', quantity: '1000' }, { price: '1.50', quantity: '500' }], crossId: '7',
};

describe('issuer form', () => {
  it('converts a valid form to exact chain units', () => {
    const r = checkIssuerForm(base, now);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.body).toMatchObject({
      minPrice: '1000000', tick: '50000', priceScale: '1000000', minMatched: '100000000',
      openTs: '1791205200', closeTs: '1791212400', revealEndTs: '1791214200', maxImbalanceBps: null,
      schedule: [{ price: '1200000', quantity: '1000000000' }, { price: '1500000', quantity: '500000000' }],
    });
  });

  it('uses the base mint decimals for the price scale (9-decimal token)', () => {
    const r = checkIssuerForm({ ...base, baseDecimals: 9, schedule: [{ price: '1.25', quantity: '2' }] }, now);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.body).toMatchObject({ priceScale: '1000000000', minPrice: '1000000', schedule: [{ price: '1250000', quantity: '2000000000' }] });
  });

  // With the grid itself invalid, steps cannot be checked against it, so only the malformed step errors.
  it('refuses every way a form can be wrong, naming the field', () => {
    const r = checkIssuerForm(
      { ...base, minPrice: '0', tick: '0.0000001', ticks: 1, openAt: new Date('2026-10-05T10:00:00Z'), closeAt: new Date('2026-10-05T09:00:00Z'), revealMinutes: 0, minMatched: 'x', maxImbalancePct: '150', integratorFeeBps: 400, shards: 0, maxOrders: 0, crossId: '-1', schedule: [{ price: '1.23', quantity: '1' }, { price: '1.10', quantity: '0' }] },
      now,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['closeAt', 'crossId', 'integratorFeeBps', 'maxImbalancePct', 'maxOrders', 'minMatched', 'minPrice', 'openAt', 'revealMinutes', 'schedule.1', 'shards', 'tick', 'ticks'].sort());
  });

  it('an off-grid price is named before the amount is typed', () => {
    const r = checkIssuerForm({ ...base, schedule: [{ price: '1.23', quantity: '' }] }, now);
    expect(!r.ok && r.errors['schedule.0']).toBe('This price is not on the grid.');
    const r2 = checkIssuerForm({ ...base, schedule: [{ price: '1.25', quantity: '' }] }, now);
    expect(!r2.ok && r2.errors['schedule.0']).toBe('Enter how many tokens this step offers.');
  });

  it('off-grid and falling supply steps are refused', () => {
    const r = checkIssuerForm({ ...base, schedule: [{ price: '1.22', quantity: '10' }, { price: '1.50', quantity: '1' }, { price: '1.40', quantity: '1' }] }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatchObject({ 'schedule.0': 'This price is not on the grid.', 'schedule.2': 'Steps must rise in price.' });
  });

  it('an escrow cross needs no schedule and an open cross no reveal window', () => {
    const r = checkIssuerForm({ ...base, supplyMode: 'escrow', disclosure: 'open', revealMinutes: 0, schedule: [] }, now);
    expect(r.ok && r.body.revealEndTs === r.body.closeTs && (r.body.schedule as unknown[]).length === 0).toBe(true);
  });
});
