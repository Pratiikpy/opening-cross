// The whole organic-volume analysis of one cross, from its orders to a guard decision, as one function over injected sources. The API route computes the same pieces from its
// database; this is the same analysis for a process that has only a chain connection and the list of orders (the volume attester), with the two additions the route lacks: the Jito
// bundle evidence and the guard. Nothing here reads a clock or a file by itself: the caller supplies the RPC, the caches and the explorer.
import { type CoordinationReport, type ExplorerDeps, type PlacementStore, coordinationLinks } from './jito.js';
import { type ConflictReport, type CrossParties, type Flag, findConflicts } from './conflicts.js';
import { type ClusterResult, type FundingCache, clusterByFunding } from './funding.js';
import { DEFAULT_ORGANIC_POLICY, type GuardResult, type OrganicPolicy, organicGuard } from './guard.js';
import { type OrganicReport, organicVolume } from './organic.js';
import { traceWallets, type TraceJobResult } from './trace.js';
import type { Funding, RpcLike } from './types.js';

export interface AnalyzedOrder {
  owner: string;
  /** The order account (for the placing transaction). */
  orderAddress: string;
  side: 'buy' | 'sell';
  /** Base atoms the order counts for, or null while sealed and unrevealed. */
  weight: bigint | null;
}

export interface AnalyzeInput {
  parties: CrossParties;
  orders: readonly AnalyzedOrder[];
  /** Addresses the issuer declared as its team, with the evidence. */
  declaredTeam?: ReadonlyMap<string, string>;
}

export interface AnalyzeDeps {
  rpc: RpcLike;
  cache: FundingCache & { fanout?: () => Map<string, number> };
  /** Funders known to be services. */
  serviceFunders?: ReadonlySet<string>;
  /** A funder that funded this many wallets is treated as a service. Default 25. */
  serviceFanout?: number;
  /** The bundle check. `false` skips it (and the report says it was not made). */
  bundles?: { explorer?: ExplorerDeps; store?: PlacementStore } | false;
  trace?: { concurrency?: number; budgetMs?: number; pageSize?: number; maxPages?: number; inspect?: number };
  policy?: OrganicPolicy;
}

export interface CrossAnalysis {
  conflicts: ConflictReport;
  clusters: ClusterResult;
  organic: OrganicReport;
  coordination: CoordinationReport | null;
  guard: GuardResult;
  trace: TraceJobResult;
  /** Owners whose funding is not known yet: they count as unknown, never as independent. */
  untracedOwners: string[];
}

export async function analyzeCross(input: AnalyzeInput, deps: AnalyzeDeps): Promise<CrossAnalysis> {
  const { parties } = input;
  const owners = [...new Set(input.orders.map((o) => o.owner))];
  const wallets = [...new Set([parties.creator, parties.proceedsTo, ...(parties.settler ? [parties.settler] : []), ...owners])];
  const trace = await traceWallets(deps.rpc, wallets, { cache: deps.cache, ...deps.trace });
  const conflicts = findConflicts({
    parties,
    orders: input.orders,
    fundings: trace.fundings,
    ...(input.declaredTeam && { declaredTeam: input.declaredTeam }),
    ...(deps.serviceFunders && { serviceFunders: deps.serviceFunders }),
  });
  const coordination = deps.bundles === false ? null : await coordinationLinks(deps.rpc, input.orders.map((o) => ({ owner: o.owner, orderAddress: o.orderAddress })), deps.bundles?.explorer ?? {}, deps.bundles?.store);
  const participants: Funding[] = owners.map((o) => trace.fundings.get(o)).filter((f): f is Funding => !!f);
  const fanout = deps.cache.fanout?.();
  const clusters = clusterByFunding(participants, {
    ...(deps.serviceFunders && { serviceFunders: deps.serviceFunders }),
    ...(fanout && { fanout }),
    ...(deps.serviceFanout !== undefined && { serviceFanout: deps.serviceFanout }),
    ...(coordination && { extraLinks: coordination.links }),
  });
  const untracedOwners = owners.filter((o) => !trace.fundings.has(o));
  for (const o of untracedOwners) clusters.unknownFunder.push(o);
  const organic = organicVolume(input.orders, conflicts, clusters, trace.fundings, coordination);
  const guard = organicGuard(organic, input.orders.filter((o) => o.weight !== null).length, deps.policy ?? DEFAULT_ORGANIC_POLICY, coordination);
  return { conflicts, clusters, organic, coordination, guard, trace, untracedOwners };
}

/** Flags carried over from another source (for example a report the API already computed from signed team declarations), as the `declaredTeam` map the conflict finder takes. */
export function declaredTeamFrom(perOwner: Readonly<Record<string, readonly Flag[]>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [owner, flags] of Object.entries(perOwner)) {
    const f = flags.find((x) => x.kind === 'declared-team');
    if (f) out.set(owner, f.evidence);
  }
  return out;
}
