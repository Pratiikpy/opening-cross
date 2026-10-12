import { describe, expect, it } from 'vitest';
import {
  PROPOSED_RATE_CARD,
  InvoiceError,
  type Scenario,
  allocateProtocolFee,
  breakEvenNotional,
  entitledAt,
  entitlementPeriods,
  formatUnits,
  listingFee,
  runModel,
  subscriptionInvoice,
  usageInvoice,
} from '../src/index.js';

const M = 1_000_000n; // one USD in micro-USD

const flow = (notional: bigint, integratorBps: number, referredBps = 0) => ({ notional, integratorBps, referredBps });
const none = flow(0n, 0);

describe('rate card', () => {
  it('listing fee is the raise times the rate, clamped', () => {
    expect(listingFee(PROPOSED_RATE_CARD, 100_000n * M)).toBe(200n * M); // 20 bps of 100,000 USD
    expect(listingFee(PROPOSED_RATE_CARD, 1_000n * M)).toBe(50n * M); // floor: 0.2% of 1,000 is 2 USD
    expect(listingFee(PROPOSED_RATE_CARD, 100_000_000n * M)).toBe(5_000n * M); // ceiling
    expect(() => listingFee(PROPOSED_RATE_CARD, -1n)).toThrow(InvoiceError);
  });

  it('a subscription is the plan price plus overage beyond the included crosses', () => {
    const within = subscriptionInvoice(PROPOSED_RATE_CARD, 'recurring-starter', 'issuer', 0, 4);
    expect(within.totalUnits).toBe(99n * M);
    const over = subscriptionInvoice(PROPOSED_RATE_CARD, 'recurring-starter', 'issuer', 0, 7);
    expect(over.totalUnits).toBe(99n * M + 3n * 25n * M);
    expect(over.periodEnd).toBe(30 * 86_400);
    expect(() => subscriptionInvoice(PROPOSED_RATE_CARD, 'nope', 'issuer', 0, 1)).toThrow(InvoiceError);
    expect(() => subscriptionInvoice(PROPOSED_RATE_CARD, 'recurring-starter', 'issuer', 0, -1)).toThrow(InvoiceError);
  });

  it('usage is count times price; unknown products are refused', () => {
    expect(usageInvoice(PROPOSED_RATE_CARD, 'agent', 0, 1, { 'proof-verification': 1000n }).totalUnits).toBe(10n * M);
    expect(() => usageInvoice(PROPOSED_RATE_CARD, 'agent', 0, 1, { mystery: 1n })).toThrow(InvoiceError);
  });

  it('formats units as text', () => {
    expect(formatUnits(99_000_000n)).toBe('99.00 USDC');
    expect(formatUnits(10_000n)).toBe('0.01 USDC');
    expect(formatUnits(1_234_567_890n)).toBe('1,234.56789 USDC');
    expect(formatUnits(-5_000_000n)).toBe('-5.00 USDC');
  });
});

describe('allocation', () => {
  it('reserves a quarter of reopen fees for the rebate pool and nothing on other kinds', () => {
    expect(allocateProtocolFee('reopen', 1_000_000n, 0n)).toEqual({ gross: 1_000_000n, referrals: 0n, rebatePool: 250_000n, operating: 750_000n });
    expect(allocateProtocolFee('launch', 1_000_000n, 100_000n)).toEqual({ gross: 1_000_000n, referrals: 100_000n, rebatePool: 0n, operating: 900_000n });
  });

  it('refuses allocations that exceed the fee', () => {
    expect(() => allocateProtocolFee('reopen', 100n, 90n)).toThrow(RangeError);
  });
});

describe('model', () => {
  const s: Scenario = {
    name: 'worked example',
    flows: { launch: flow(1_000_000n * M, 120), reopen: flow(2_000_000n * M, 20, 2_000), tender: none, recurring: none },
    subscriptions: { 'recurring-starter': { count: 10, crossesPerMonth: 4 } },
    listings: [100_000n * M],
    usage: { 'proof-verification': 50_000n },
  };

  it('reproduces the hand calculation', () => {
    const r = runModel(s);
    // Launch: 1,000,000 USD at 30 + 120 bps. Total 150 bps = 15,000 USD; protocol 30/150 = 3,000 USD; integrator 12,000 USD.
    expect(r.byKind.launch).toMatchObject({ protocolBps: 30, totalFee: 15_000n * M, protocolFee: 3_000n * M, integratorFee: 12_000n * M, costTenthsBps: 1_500n });
    // Reopen: 2,000,000 USD at 5 + 20 bps. Total 25 bps = 5,000 USD; protocol 1,000 USD; rebate 250 USD;
    // 20% of the flow is referred: 10% of 20% of 1,000 USD is 20 USD.
    expect(r.byKind.reopen).toMatchObject({ protocolBps: 5, totalFee: 5_000n * M, protocolFee: 1_000n * M, referrals: 20n * M, rebatePool: 250n * M });
    expect(r.protocolFee).toBe(4_000n * M);
    expect(r.protocolNet).toBe(4_000n * M - 20n * M - 250n * M);
    expect(r.subscriptions).toBe(990n * M);
    expect(r.listings).toBe(200n * M);
    expect(r.usage).toBe(500n * M);
    expect(r.operatingRevenue).toBe(3_730n * M + 990n * M + 200n * M + 500n * M);
  });

  it('a flow with no integrator fee earns the protocol nothing (the public-good tier)', () => {
    const r = runModel({ ...s, flows: { launch: flow(1_000_000n * M, 0), reopen: none, tender: none, recurring: none }, subscriptions: {}, listings: [], usage: {} });
    expect(r.protocolFee).toBe(0n);
    expect(r.byKind.launch.totalFee).toBe(0n);
  });

  it('break-even volume is where revenue equals cost, exactly', () => {
    const mix = { launch: 5_000, reopen: 5_000, tender: 0, recurring: 0 };
    const cost = 10_000n * M;
    const n = breakEvenNotional(cost, mix, 120, 0n);
    expect(n).not.toBeNull();
    const at = (notional: bigint) =>
      runModel({ name: 'be', flows: { launch: flow((notional * 5_000n) / 10_000n, 120), reopen: flow((notional * 5_000n) / 10_000n, 120), tender: none, recurring: none }, subscriptions: {}, listings: [], usage: {} }).protocolNet;
    // At the break-even volume the model earns the cost to within rounding, and one more micro-dollar of cost needs more volume.
    expect(at(n as bigint)).toBeGreaterThanOrEqual(cost - 3n);
    expect(at((n as bigint) - 100_000n)).toBeLessThan(cost);
    expect(breakEvenNotional(cost, mix, 0, 0n)).toBeNull();
    expect(breakEvenNotional(cost, mix, 120, cost)).toBe(0n);
    expect(() => breakEvenNotional(cost, { ...mix, launch: 1 }, 120, 0n)).toThrow(RangeError);
  });
});

describe('entitlement', () => {
  const day = 86_400;
  it('a payment buys one period; paying early extends instead of overlapping', () => {
    const { periods, rejected } = entitlementPeriods(PROPOSED_RATE_CARD, [
      { plan: 'recurring-starter', paidAt: 1_000, amountUnits: 99n * M },
      { plan: 'recurring-starter', paidAt: 1_000 + 10 * day, amountUnits: 99n * M },
    ]);
    expect(rejected).toEqual([]);
    expect(periods[0]).toMatchObject({ start: 1_000, end: 1_000 + 30 * day });
    expect(periods[1]).toMatchObject({ start: 1_000 + 30 * day, end: 1_000 + 60 * day });
    expect(entitledAt(periods, 1_000 + 45 * day)?.start).toBe(1_000 + 30 * day);
    expect(entitledAt(periods, 1_000 + 60 * day)).toBeNull();
    expect(entitledAt(periods, 999)).toBeNull();
  });

  it('a lapsed subscription restarts at the new payment', () => {
    const { periods } = entitlementPeriods(PROPOSED_RATE_CARD, [
      { plan: 'recurring-starter', paidAt: 0, amountUnits: 99n * M },
      { plan: 'recurring-starter', paidAt: 100 * day, amountUnits: 99n * M },
    ]);
    expect(periods[1]).toMatchObject({ start: 100 * day });
    expect(entitledAt(periods, 50 * day)).toBeNull();
  });

  it('an underpayment or an unknown plan buys nothing and is reported', () => {
    const { periods, rejected } = entitlementPeriods(PROPOSED_RATE_CARD, [
      { plan: 'recurring-starter', paidAt: 5, amountUnits: 98_999_999n },
      { plan: 'enterprise', paidAt: 6, amountUnits: 1_000n * M },
    ]);
    expect(periods).toEqual([]);
    expect(rejected).toHaveLength(2);
  });
});
