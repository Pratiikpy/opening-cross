// The fee model (ADR-0010: "final bps values are modelled before mainnet"). It turns a scenario, meaning how much
// notional clears per month in each kind of cross and what integrators charge on top, into what each party pays and
// what the protocol keeps, using the program's own fee rules from `schedule.ts` and the payout rules of `policy.ts`.
//
// What it is: arithmetic that is exact for the inputs given. What it is not: a forecast. Volume, the mix of
// integrators and the share of referred flow are INPUTS. No input in this file is a measurement of the market; the
// proposed scenarios are labelled as such, and `breakEvenNotional` answers "how much volume would be needed" instead
// of predicting any.
import { PROPOSED_RATE_CARD, type RateCard, listingFee, subscriptionInvoice } from './invoice.js';
import { REFERRAL_SHARE_BPS } from './referral.js';
import { BPS, type CrossKind, type FeeSchedule, KINDS, PROPOSED_SCHEDULE, protocolFeeBps } from './schedule.js';
import { REBATE_SHARE_BPS } from './policy.js';

export type KindFlow = {
  /** Quote notional that clears per month, in micro-USD. */
  readonly notional: bigint;
  /** The integrator fee charged on it, in bps (0 means the zero-fee public-good tier: no fees at all). */
  readonly integratorBps: number;
  /** Share of this flow that came through a referral, in bps. */
  readonly referredBps: number;
};

export type Scenario = {
  readonly name: string;
  readonly flows: Readonly<Record<CrossKind, KindFlow>>;
  /** Subscriptions by plan name. */
  readonly subscriptions: Readonly<Record<string, { readonly count: number; readonly crossesPerMonth: number }>>;
  /** Raises (micro-USD) of the listings made in the month. */
  readonly listings: readonly bigint[];
  /** Usage events by product. */
  readonly usage: Readonly<Record<string, bigint>>;
};

export type KindResult = {
  readonly notional: bigint;
  readonly protocolBps: number;
  readonly integratorBps: number;
  readonly totalFee: bigint;
  readonly protocolFee: bigint;
  readonly integratorFee: bigint;
  readonly referrals: bigint;
  readonly rebatePool: bigint;
  /** What the fee costs the paying side, in tenths of a basis point of notional. */
  readonly costTenthsBps: bigint;
};

export type ModelResult = {
  readonly scenario: string;
  readonly byKind: Readonly<Record<CrossKind, KindResult>>;
  readonly protocolFee: bigint;
  readonly referrals: bigint;
  readonly rebatePool: bigint;
  readonly protocolNet: bigint;
  readonly integratorFee: bigint;
  readonly subscriptions: bigint;
  readonly listings: bigint;
  readonly usage: bigint;
  /** Net protocol fees plus the metered lines: what the company keeps before its costs. */
  readonly operatingRevenue: bigint;
};

const zeroFlow: KindFlow = { notional: 0n, integratorBps: 0, referredBps: 0 };

export function runModel(s: Scenario, schedule: FeeSchedule = PROPOSED_SCHEDULE, card: RateCard = PROPOSED_RATE_CARD): ModelResult {
  const byKind = {} as Record<CrossKind, KindResult>;
  let protocolFee = 0n;
  let referrals = 0n;
  let rebatePool = 0n;
  let integratorFee = 0n;
  for (const k of KINDS) {
    const f = s.flows[k] ?? zeroFlow;
    const pBps = protocolFeeBps(schedule, k, f.integratorBps);
    const total = BigInt(pBps + f.integratorBps);
    const totalFee = (f.notional * total) / BPS;
    const pFee = total === 0n ? 0n : (totalFee * BigInt(pBps)) / total;
    const iFee = totalFee - pFee;
    const ref = (((pFee * BigInt(f.referredBps)) / BPS) * BigInt(REFERRAL_SHARE_BPS)) / BPS;
    const rebate = k === 'reopen' ? (pFee * BigInt(REBATE_SHARE_BPS)) / BPS : 0n;
    byKind[k] = { notional: f.notional, protocolBps: pBps, integratorBps: f.integratorBps, totalFee, protocolFee: pFee, integratorFee: iFee, referrals: ref, rebatePool: rebate, costTenthsBps: f.notional === 0n ? 0n : (totalFee * 100_000n) / f.notional };
    protocolFee += pFee;
    referrals += ref;
    rebatePool += rebate;
    integratorFee += iFee;
  }
  let subs = 0n;
  for (const [plan, v] of Object.entries(s.subscriptions)) subs += BigInt(v.count) * subscriptionInvoice(card, plan, 'model', 0, v.crossesPerMonth).totalUnits;
  const listings = s.listings.reduce((a, r) => a + listingFee(card, r), 0n);
  let usage = 0n;
  for (const [product, n] of Object.entries(s.usage)) {
    const rate = card.usage.find((u) => u.product === product);
    if (!rate) throw new RangeError(`the rate card has no usage product "${product}"`);
    usage += n * rate.priceUnits;
  }
  const protocolNet = protocolFee - referrals - rebatePool;
  return { scenario: s.name, byKind, protocolFee, referrals, rebatePool, protocolNet, integratorFee, subscriptions: subs, listings, usage, operatingRevenue: protocolNet + subs + listings + usage };
}

/**
 * The monthly notional, spread over kinds in the proportions of `mix` (bps, summing to 10,000) and charged at
 * `integratorBps`, at which operating revenue equals `monthlyCost`. Net protocol revenue is linear in notional:
 *   revenue(N) = N x sum_k mix_k x p_k x (10,000 - r_k) / 10,000^3
 * with p_k the protocol bps of kind k and r_k the rebate share in bps (nonzero for reopens only). Referrals are left
 * out, which is the conservative case. The result is rounded up to a whole micro-USD. Returns null when the mix earns
 * nothing per unit of notional (for example at an integrator fee of zero, where the protocol takes nothing).
 */
export function breakEvenNotional(monthlyCost: bigint, mix: Readonly<Record<CrossKind, number>>, integratorBps: number, fixedRevenue: bigint, schedule: FeeSchedule = PROPOSED_SCHEDULE): bigint | null {
  if (KINDS.reduce((a, k) => a + (mix[k] ?? 0), 0) !== 10_000) throw new RangeError('the mix must sum to 10,000 bps');
  const need = monthlyCost - fixedRevenue;
  if (need <= 0n) return 0n;
  let coefficient = 0n;
  for (const k of KINDS) {
    const rebate = k === 'reopen' ? REBATE_SHARE_BPS : 0;
    coefficient += BigInt(mix[k] ?? 0) * BigInt(protocolFeeBps(schedule, k, integratorBps)) * BigInt(10_000 - rebate);
  }
  if (coefficient === 0n) return null;
  return (need * 1_000_000_000_000n + coefficient - 1n) / coefficient;
}
