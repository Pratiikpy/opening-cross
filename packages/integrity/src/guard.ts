// The guard over the organic-volume interval (F2): what a consumer may do with the measure. The measure is a pair of bounds counted from facts (organic.ts); this module turns it
// into a decision, and the decision is conservative in the direction that protects the user:
//
//   fail  the facts show that too much of the volume is NOT organic (conflicted bidders, or a funding or bundle group that bid on both sides). Nothing is attested; a figure that
//         was attested earlier is withdrawn.
//   hold  the facts do not show enough either way: too much volume is unproven (a wallet not traced yet, a funder that is a service) or too many placements could not be checked
//         for bundle links. Nothing is attested yet, and a later pass reads more evidence.
//   pass  at least `minLowerBps` of volume is shown independent, across at least `minIndependentGroups` independent bidder groups, and no more than `maxInorganicBps` is shown
//         inorganic. What is attested is the LOWER bound, never the upper: an attester states what it can show, not what it cannot disprove.
//
// The policy is data, not code, so an operator and a charter can read it. The defaults are ours and unfitted: they are stated, not claimed to be optimal, and the release bar for
// the measure (bars/ovs.ts) says what evidence would justify moving them.
import type { CoordinationReport } from './jito.js';
import type { OrganicReport } from './organic.js';

export interface OrganicPolicy {
  /** Version of the policy, recorded with every decision. */
  version: string;
  /** Lower bound required to pass, in basis points of volume. */
  minLowerBps: number;
  /** Independent bidder groups required to pass (a cluster counts once, an independent wallet once). */
  minIndependentGroups: number;
  /** Fail when volume shown inorganic (conflicted, cross-side self-trade) is at least this share. */
  maxInorganicBps: number;
  /** Hold when volume neither shown organic nor inorganic exceeds this share and the lower bound is short of the bar. */
  maxUnprovenBps: number;
  /** Hold when more than this share of placements could not be looked up for bundle links. Ignored when no coordination report is given. */
  maxUncheckedPlacementsBps: number;
  /** Hold below this many orders with a known weight: a thin cross cannot support a share. */
  minWeightedOrders: number;
}

export const DEFAULT_ORGANIC_POLICY: OrganicPolicy = {
  version: 'ovs-guard-v0-unfitted',
  minLowerBps: 5_000,
  minIndependentGroups: 8,
  maxInorganicBps: 2_000,
  maxUnprovenBps: 2_500,
  maxUncheckedPlacementsBps: 3_000,
  minWeightedOrders: 8,
};

export type GuardDecision = 'pass' | 'hold' | 'fail';
export type GuardReason =
  | 'THIN_CROSS'
  | 'INORGANIC_SHARE'
  | 'LOWER_BOUND_SHORT'
  | 'FEW_INDEPENDENT_GROUPS'
  | 'MUCH_UNPROVEN'
  | 'PLACEMENTS_UNCHECKED'
  | 'NO_VOLUME'
  | 'MEETS_BAR';

export interface GuardResult {
  decision: GuardDecision;
  policy: string;
  reasons: { code: GuardReason; message: string }[];
  /** Base atoms shown independent: what a pass attests, converted to quote atoms by the caller. Zero unless the decision is `pass`. */
  attestableBase: bigint;
  /** The measure the decision rests on, for the record. */
  basis: { lowerBps: number; upperBps: number; inorganicBps: number; unprovenBps: number; independentGroups: number; weightedOrders: number; uncheckedPlacementsBps: number | null };
}

const bpsOf = (part: bigint, total: bigint): number => (total === 0n ? 0 : Number((part * 10_000n) / total));

/**
 * Decides what the measure allows. `orderCount` is the number of orders with a known weight. `coordination` is the Jito evidence, when it was gathered; without it the bundle
 * check simply was not done and the result says nothing about bundles (the report's own `barsUnmet` already lists that).
 */
export function organicGuard(report: OrganicReport, orderCount: number, policy: OrganicPolicy = DEFAULT_ORGANIC_POLICY, coordination?: CoordinationReport | null): GuardResult {
  const inorganicBps = bpsOf(report.volume.conflicted + report.volume.crossSideSelfTrade, report.total);
  const unprovenBps = bpsOf(report.volume.unproven + report.volume.serviceFunded, report.total);
  const unchecked = coordination ? (coordination.placements.length === 0 ? 0 : Math.floor((coordination.unknown.count * 10_000) / coordination.placements.length)) : null;
  const basis = { lowerBps: report.lowerBps, upperBps: report.upperBps, inorganicBps, unprovenBps, independentGroups: report.breadth.independentGroups, weightedOrders: orderCount, uncheckedPlacementsBps: unchecked };
  const result = (decision: GuardDecision, reasons: GuardResult['reasons']): GuardResult => ({ decision, policy: policy.version, reasons, attestableBase: decision === 'pass' ? report.volume.independent : 0n, basis });

  if (report.total === 0n) return result('hold', [{ code: 'NO_VOLUME', message: 'No order has a known weight yet, so there is no volume to measure.' }]);
  if (inorganicBps >= policy.maxInorganicBps) {
    return result('fail', [{ code: 'INORGANIC_SHARE', message: `${inorganicBps / 100}% of volume is shown not to be organic (bidders tied to the issuer, or a group that bid on both sides), at or above the ${policy.maxInorganicBps / 100}% limit.` }]);
  }
  const holds: GuardResult['reasons'] = [];
  if (orderCount < policy.minWeightedOrders) holds.push({ code: 'THIN_CROSS', message: `${orderCount} orders have a known weight; at least ${policy.minWeightedOrders} are needed before a share means anything.` });
  if (report.lowerBps < policy.minLowerBps) {
    holds.push({ code: 'LOWER_BOUND_SHORT', message: `${report.lowerBps / 100}% of volume is shown independent; ${policy.minLowerBps / 100}% is needed.` });
    if (unprovenBps > policy.maxUnprovenBps) holds.push({ code: 'MUCH_UNPROVEN', message: `${unprovenBps / 100}% of volume is neither shown organic nor shown inorganic (untraced wallets or service-funded wallets); more tracing may move the lower bound.` });
  }
  if (report.breadth.independentGroups < policy.minIndependentGroups) holds.push({ code: 'FEW_INDEPENDENT_GROUPS', message: `${report.breadth.independentGroups} independent bidder groups; at least ${policy.minIndependentGroups} are needed.` });
  if (unchecked !== null && unchecked > policy.maxUncheckedPlacementsBps) holds.push({ code: 'PLACEMENTS_UNCHECKED', message: `${unchecked / 100}% of order placements could not be checked for bundle links (${coordination!.unknown.reasons.join('; ')}).` });
  if (holds.length > 0) return result('hold', holds);
  return result('pass', [{ code: 'MEETS_BAR', message: `${report.lowerBps / 100}% of volume is shown independent across ${report.breadth.independentGroups} groups, and ${inorganicBps / 100}% is shown inorganic.` }]);
}

/** The organic volume in quote atoms for a base-atom volume at the clearing price: `base * price / priceScale`, rounded down so the figure never overstates. */
export function quoteVolume(baseAtoms: bigint, price: bigint, priceScale: bigint): bigint {
  if (priceScale <= 0n) throw new RangeError('priceScale must be positive');
  return (baseAtoms * price) / priceScale;
}

export type OrganicTier = 'A' | 'B' | 'C' | 'none';
/** A listing tier from the lower bound and the breadth. Both must clear a rung; a failed or held guard is `none`. */
export function organicTier(g: GuardResult): OrganicTier {
  if (g.decision !== 'pass') return 'none';
  const { lowerBps, independentGroups } = g.basis;
  if (lowerBps >= 8_000 && independentGroups >= 25) return 'A';
  if (lowerBps >= 6_500 && independentGroups >= 15) return 'B';
  return 'C';
}
