// Rate cards and invoices for the metered lines (PRODUCT_FEATURES Y8, X11, P1, P3 to P5): the issuer subscription for
// managed recurring crosses, the template listing fee scaled to the raise, and per-use charges such as the proof
// verification API. Amounts are integers in the smallest unit of the billing currency (USDC, 6 decimals).
//
// What a rate card buys is the managed service around the permissionless program (the scheduler, the keeper, the
// hosted API, signed bands, support). It does not gate the program: anyone can still create a cross on chain, and the
// protocol fee in `schedule.ts` is charged regardless. A card has a status: `proposed` until the founder publishes
// it, and every figure in the proposed card is a proposal, not a measurement of what issuers will pay.
import { BPS } from './schedule.js';

export const RATE_CARD_SCHEMA = 'opening-cross/rate-card/v1';

export type Plan = {
  readonly plan: string;
  readonly periodDays: number;
  readonly priceUnits: bigint;
  readonly includedCrosses: number;
  /** Charged per cross beyond the included count, in the same period. */
  readonly overagePerCrossUnits: bigint;
};

export type UsageRate = { readonly product: string; readonly unit: string; readonly priceUnits: bigint };

export type RateCard = {
  readonly schema: typeof RATE_CARD_SCHEMA;
  readonly version: string;
  readonly status: 'proposed' | 'published';
  readonly currency: { readonly symbol: string; readonly decimals: number };
  readonly listing: { readonly bps: number; readonly minUnits: bigint; readonly maxUnits: bigint };
  readonly plans: readonly Plan[];
  readonly usage: readonly UsageRate[];
};

/** Proposed figures. See : they are inputs to the fee model, not evidence of willingness to pay. */
export const PROPOSED_RATE_CARD: RateCard = {
  schema: RATE_CARD_SCHEMA,
  version: '2026-10-proposal-1',
  status: 'proposed',
  currency: { symbol: 'USDC', decimals: 6 },
  listing: { bps: 20, minUnits: 50_000_000n, maxUnits: 5_000_000_000n },
  plans: [
    { plan: 'recurring-starter', periodDays: 30, priceUnits: 99_000_000n, includedCrosses: 4, overagePerCrossUnits: 25_000_000n },
    { plan: 'recurring-weekly', periodDays: 30, priceUnits: 399_000_000n, includedCrosses: 22, overagePerCrossUnits: 15_000_000n },
  ],
  usage: [
    { product: 'proof-verification', unit: 'call', priceUnits: 10_000n },
    { product: 'attestation', unit: 'attestation', priceUnits: 250_000n },
    { product: 'data-export', unit: 'request', priceUnits: 50_000n },
    { product: 'order-desk', unit: 'call', priceUnits: 20_000n },
  ],
};

export class InvoiceError extends RangeError {
  override readonly name = 'InvoiceError';
}

/** The listing fee for a raise of `raiseUnits`: `raise x bps`, never below the minimum or above the maximum. */
export function listingFee(card: RateCard, raiseUnits: bigint): bigint {
  if (raiseUnits < 0n) throw new InvoiceError('a raise cannot be negative');
  const scaled = (raiseUnits * BigInt(card.listing.bps)) / BPS;
  return scaled < card.listing.minUnits ? card.listing.minUnits : scaled > card.listing.maxUnits ? card.listing.maxUnits : scaled;
}

export type InvoiceLine = { readonly description: string; readonly quantity: bigint; readonly unitUnits: bigint; readonly totalUnits: bigint };
export type Invoice = {
  readonly card: string;
  readonly party: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly lines: readonly InvoiceLine[];
  readonly totalUnits: bigint;
};

const line = (description: string, quantity: bigint, unitUnits: bigint): InvoiceLine => ({ description, quantity, unitUnits, totalUnits: quantity * unitUnits });

/** One period of a subscription: the plan price once, plus overage for crosses beyond the included count. */
export function subscriptionInvoice(card: RateCard, planName: string, party: string, periodStart: number, crossesUsed: number): Invoice {
  const plan = card.plans.find((p) => p.plan === planName);
  if (!plan) throw new InvoiceError(`the rate card has no plan "${planName}"`);
  if (!Number.isInteger(crossesUsed) || crossesUsed < 0) throw new InvoiceError('crossesUsed must be a non-negative integer');
  const lines = [line(`${plan.plan}, ${plan.periodDays} days, ${plan.includedCrosses} crosses included`, 1n, plan.priceUnits)];
  const over = Math.max(0, crossesUsed - plan.includedCrosses);
  if (over > 0) lines.push(line('crosses beyond the plan', BigInt(over), plan.overagePerCrossUnits));
  return { card: card.version, party, periodStart, periodEnd: periodStart + plan.periodDays * 86_400, lines, totalUnits: lines.reduce((a, l) => a + l.totalUnits, 0n) };
}

export function usageInvoice(card: RateCard, party: string, periodStart: number, periodEnd: number, counts: Readonly<Record<string, bigint>>): Invoice {
  const lines: InvoiceLine[] = [];
  for (const [product, n] of Object.entries(counts)) {
    const rate = card.usage.find((u) => u.product === product);
    if (!rate) throw new InvoiceError(`the rate card has no usage product "${product}"`);
    if (n < 0n) throw new InvoiceError('a usage count cannot be negative');
    if (n > 0n) lines.push(line(`${product}, per ${rate.unit}`, n, rate.priceUnits));
  }
  return { card: card.version, party, periodStart, periodEnd, lines, totalUnits: lines.reduce((a, l) => a + l.totalUnits, 0n) };
}

/** Human text for an amount in billing units: `99.00 USDC`. */
export function formatUnits(units: bigint, decimals = 6, symbol = 'USDC'): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${neg ? '-' : ''}${(abs / base).toLocaleString('en-US')}.${frac} ${symbol}`;
}

export type SubscriptionPayment = { readonly plan: string; readonly paidAt: number; readonly amountUnits: bigint };
export type EntitlementPeriod = { readonly plan: string; readonly start: number; readonly end: number; readonly paymentAt: number };

/**
 * Turns an issuer's payments into the periods they pay for. A payment buys one period of its plan. A payment made while
 * a period is still running extends it: the new period starts when the previous one ends, so paying early loses
 * nothing. A payment below the plan price buys nothing (it is listed in `rejected`). Payments are applied in time order.
 */
export function entitlementPeriods(card: RateCard, payments: readonly SubscriptionPayment[]): { readonly periods: EntitlementPeriod[]; readonly rejected: readonly SubscriptionPayment[] } {
  const periods: EntitlementPeriod[] = [];
  const rejected: SubscriptionPayment[] = [];
  let cursor = 0;
  for (const p of [...payments].sort((a, b) => a.paidAt - b.paidAt)) {
    const plan = card.plans.find((x) => x.plan === p.plan);
    if (!plan || p.amountUnits < plan.priceUnits) {
      rejected.push(p);
      continue;
    }
    const start = Math.max(p.paidAt, cursor);
    const end = start + plan.periodDays * 86_400;
    periods.push({ plan: plan.plan, start, end, paymentAt: p.paidAt });
    cursor = end;
  }
  return { periods, rejected };
}

/** The plan in force at `at`, or null. */
export function entitledAt(periods: readonly EntitlementPeriod[], at: number): EntitlementPeriod | null {
  return periods.find((x) => x.start <= at && at < x.end) ?? null;
}
