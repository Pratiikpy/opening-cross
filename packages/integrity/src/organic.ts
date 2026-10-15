// Organic-volume score, version 0 (F2). EXPERIMENTAL: it states two bounds, both counted from facts on chain, and gates nothing.
//
//   lower  = volume from bidders whose independence is shown: a traced funder shared with no other bidder, and no tie to the issuer.
//   upper  = total volume minus what is shown NOT to be organic: volume of conflicted bidders, and the self-trade a funding cluster
//            could have made by bidding on both sides.
//   in between is volume nothing shows either way (an unknown funder, or a linked group on one side only).
//
// A reader gets the interval, not a point, because the evidence cannot support a point: an untraced wallet is not independent and
// not manipulative. Ranking on the lower bound is the conservative reading and the one the product definition asks for.
import { type ConflictReport } from './conflicts.js';
import { type ClusterResult } from './funding.js';
import type { CoordinationReport } from './jito.js';
import type { Funding } from './types.js';

export interface OrderWeight {
  owner: string;
  side: 'buy' | 'sell';
  weight: bigint | null;
}

export type Standing = 'conflicted' | 'cross-side-cluster' | 'one-side-cluster' | 'unknown-funder' | 'service-funded' | 'independent';

export interface OrganicReport {
  experimental: true;
  total: bigint;
  /** Volume shown organic, basis points of total. */
  lowerBps: number;
  /** Volume not shown inorganic, basis points of total. */
  upperBps: number;
  /** Volume from bidders funded by a public service (an exchange, a faucet) that also funded many others: no link to another bidder is shown, but no independence either. In basis points of total. */
  serviceFundedBps: number;
  volume: { independent: bigint; serviceFunded: bigint; conflicted: bigint; crossSideSelfTrade: bigint; unproven: bigint };
  /** Independent funding groups among bidders that are not conflicted: each cluster counts once, each independent wallet once. */
  breadth: { owners: number; independentGroups: number };
  perOwner: Record<string, Standing>;
  crossSideClusters: { members: string[]; buy: bigint; sell: bigint; potentialSelfTrade: bigint }[];
  unweightedOrders: number;
  /** The Jito bundle evidence, when it was gathered: how many order placements were looked up and how they came out. Absent when no bundle check was made. */
  coordination?: { placements: number; bundled: number; notBundled: number; unknown: number; linkedOwners: number };
  /** What this version does not do, and the bars it has not met. */
  barsUnmet: string[];
}

/**
 * `clusters` should already carry any bundle links (`clusterByFunding(..., { extraLinks: coordination.links })`); `coordination` is passed here only so the report can say that the
 * bundle check was made and how much of the cross it covered.
 */
export function organicVolume(orders: readonly OrderWeight[], conflicts: ConflictReport, clusters: ClusterResult, fundings: ReadonlyMap<string, Funding> = new Map(), coordination?: CoordinationReport | null): OrganicReport {
  const owners = [...new Set(orders.map((o) => o.owner))];
  const clusterOf = new Map<string, number>();
  clusters.clusters.forEach((c, i) => c.members.forEach((m) => clusterOf.set(m, i)));
  const unknown = new Set(clusters.unknownFunder);
  const services = new Set(clusters.ignoredServices.map((s) => s.funder));

  const w = (side: 'buy' | 'sell', pred: (o: string) => boolean) => orders.reduce((s, o) => (o.side === side && o.weight !== null && pred(o.owner) ? s + o.weight : s), 0n);

  // Cross-side clusters: a funding group that bid on both sides of this cross.
  const crossSide: OrganicReport['crossSideClusters'] = [];
  const crossSideIdx = new Set<number>();
  clusters.clusters.forEach((c, i) => {
    const mem = new Set(c.members.filter((m) => owners.includes(m)));
    const buy = w('buy', (o) => mem.has(o));
    const sell = w('sell', (o) => mem.has(o));
    const bothSides = orders.some((o) => mem.has(o.owner) && o.side === 'buy') && orders.some((o) => mem.has(o.owner) && o.side === 'sell');
    if (bothSides) {
      crossSideIdx.add(i);
      crossSide.push({ members: [...mem], buy, sell, potentialSelfTrade: buy < sell ? buy : sell });
    }
  });

  const perOwner: Record<string, Standing> = {};
  for (const o of owners) {
    const ci = clusterOf.get(o);
    if (conflicts.perOwner[o]?.some((f) => f.strength === 'high')) perOwner[o] = 'conflicted';
    else if (ci !== undefined && crossSideIdx.has(ci)) perOwner[o] = 'cross-side-cluster';
    else if (ci !== undefined) perOwner[o] = 'one-side-cluster';
    else if (unknown.has(o) || !clusters.alone.includes(o)) perOwner[o] = 'unknown-funder';
    else if (services.has(fundings.get(o)?.funder ?? '')) perOwner[o] = 'service-funded';
    else perOwner[o] = 'independent';
  }

  const sum = (pred: (s: Standing) => boolean) => orders.reduce((s, o) => (o.weight !== null && pred(perOwner[o.owner]!) ? s + o.weight : s), 0n);
  const total = orders.reduce((s, o) => s + (o.weight ?? 0n), 0n);
  const independent = sum((s) => s === 'independent');
  const serviceFunded = sum((s) => s === 'service-funded');
  const conflicted = sum((s) => s === 'conflicted');
  // Self-trade cannot exceed what the cluster bid on its smaller side, counted twice (one buy, one sell), and cannot exceed the cluster's own volume that is not already counted as conflicted.
  let selfTrade = 0n;
  for (const c of crossSide) {
    const own = orders.reduce((s, o) => (c.members.includes(o.owner) && o.weight !== null && perOwner[o.owner] !== 'conflicted' ? s + o.weight : s), 0n);
    const two = c.potentialSelfTrade * 2n;
    selfTrade += two < own ? two : own;
  }
  const unproven = total - independent - serviceFunded - conflicted - selfTrade;
  const bps = (v: bigint) => (total === 0n ? 0 : Number((v * 10_000n) / total));
  const groups = new Set<string>();
  for (const o of owners) {
    if (perOwner[o] === 'conflicted') continue;
    const ci = clusterOf.get(o);
    groups.add(ci !== undefined ? `cluster:${ci}` : `wallet:${o}`);
  }
  return {
    experimental: true,
    total,
    lowerBps: bps(independent),
    upperBps: bps(total - conflicted - selfTrade),
    serviceFundedBps: bps(serviceFunded),
    volume: { independent, serviceFunded, conflicted, crossSideSelfTrade: selfTrade, unproven },
    breadth: { owners: owners.length, independentGroups: groups.size },
    perOwner,
    crossSideClusters: crossSide,
    unweightedOrders: orders.filter((o) => o.weight === null).length,
    ...(coordination && { coordination: { placements: coordination.placements.length, bundled: coordination.bundled, notBundled: coordination.notBundled, unknown: coordination.unknown.count, linkedOwners: coordination.coordinated.length } }),
    barsUnmet: [
      coordination
        ? `Jito bundle evidence covers ${coordination.placements.length - coordination.unknown.count} of ${coordination.placements.length} order placements; the public explorer keeps about seven days, so an older or unreachable placement is unknown, not clean.`
        : 'No Jito bundle data was gathered for this measure: orders assembled together by one party in a bundle are not seen.',
      'Not validated against a labelled set of real wash trading; the wash-injection tests prove the bounds move the right way on synthetic injections, not how accurate they are on real manipulation.',
      'First-funder tracing only: a wallet funded through a chain of intermediaries is not linked.',
      'Devnet traffic only so far; no mainnet crosses exist to score.',
    ],
  };
}
