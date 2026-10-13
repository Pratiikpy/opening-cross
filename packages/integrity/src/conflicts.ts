// Conflicted-wallet flags (F8). A bidder is conflicted when the facts on chain tie it to the party running the cross: it IS the
// issuer or somebody the issuer pays, or its first SOL came from the issuer or from the issuer's own funder. A flag is a fact
// with its evidence, never a verdict about intent; the strength says how direct the tie is.
import type { Funding } from './types.js';

export type ConflictKind = 'issuer' | 'proceeds-recipient' | 'settler' | 'declared-team' | 'funded-by-issuer' | 'shares-funder-with-issuer' | 'integrator' | 'fee-recipient';
export interface Flag {
  kind: ConflictKind;
  /** high: the wallet is, or is paid by, the issuer. medium: a probable link or a party with a stake in the cross. */
  strength: 'high' | 'medium';
  evidence: string;
}

export interface CrossParties {
  address: string;
  creator: string;
  proceedsTo: string;
  integrator: string;
  feeRecipient: string;
  settler?: string | null;
}

export interface OrderFacts {
  owner: string;
  side: 'buy' | 'sell';
  /** Base atoms the order counts for: its fill once settled, else its quantity, else null (a sealed order not yet revealed). */
  weight: bigint | null;
}

export interface ConflictReport {
  cross: string;
  perOwner: Record<string, Flag[]>;
  /** Orders by flagged owners, and the share of known volume they carry, in basis points. */
  flagged: { orders: number; ordersOfTotal: number; volumeBps: number; byStrength: { high: number; medium: number } };
  /** Orders whose volume is not yet known, which no volume share can include. */
  unweightedOrders: number;
  limits: string[];
}

export interface ConflictInput {
  parties: CrossParties;
  orders: readonly OrderFacts[];
  /** First funders by wallet, for the owners and for the issuer parties. A missing entry means "not traced", not "independent". */
  fundings: ReadonlyMap<string, Funding>;
  /** Addresses the issuer declared as its team. */
  declaredTeam?: ReadonlyMap<string, string>;
  /** Funders to disregard for the shared-funder rule. */
  serviceFunders?: ReadonlySet<string>;
}

export function findConflicts(input: ConflictInput): ConflictReport {
  const { parties: p, orders, fundings } = input;
  const issuerSet = new Map<string, string>([[p.creator, 'creator of the cross']]);
  if (!issuerSet.has(p.proceedsTo)) issuerSet.set(p.proceedsTo, 'receives the issuer\'s proceeds');
  if (p.settler && !issuerSet.has(p.settler)) issuerSet.set(p.settler, 'the cross\'s settler');
  const service = input.serviceFunders ?? new Set<string>();
  const issuerFunders = new Map<string, string>();
  for (const a of issuerSet.keys()) {
    const f = fundings.get(a)?.funder;
    if (f && !service.has(f)) issuerFunders.set(f, a);
  }

  const perOwner: Record<string, Flag[]> = {};
  const owners = [...new Set(orders.map((o) => o.owner))];
  for (const owner of owners) {
    const flags: Flag[] = [];
    if (owner === p.creator) flags.push({ kind: 'issuer', strength: 'high', evidence: `${owner} created this cross` });
    if (owner === p.proceedsTo && owner !== p.creator) flags.push({ kind: 'proceeds-recipient', strength: 'high', evidence: `${owner} receives the issuer's proceeds` });
    if (p.settler && owner === p.settler && owner !== p.creator) flags.push({ kind: 'settler', strength: 'high', evidence: `${owner} is the cross's settler` });
    const team = input.declaredTeam?.get(owner);
    if (team) flags.push({ kind: 'declared-team', strength: 'high', evidence: team });
    if (owner === p.integrator && owner !== p.creator) flags.push({ kind: 'integrator', strength: 'medium', evidence: `${owner} is the integrator of this cross and earns its integrator fee` });
    if (owner === p.feeRecipient && owner !== p.creator) flags.push({ kind: 'fee-recipient', strength: 'medium', evidence: `${owner} receives the protocol fee` });
    const f = fundings.get(owner);
    if (f?.funder) {
      const viaIssuer = issuerSet.get(f.funder);
      if (viaIssuer) flags.push({ kind: 'funded-by-issuer', strength: 'high', evidence: `${f.funder} (${viaIssuer}) sent ${owner} its first SOL (${f.lamports} lamports, tx ${f.signature})` });
      else if (issuerFunders.has(f.funder)) flags.push({ kind: 'shares-funder-with-issuer', strength: 'medium', evidence: `${owner} and ${issuerFunders.get(f.funder)} (an issuer party) both received their first SOL from ${f.funder}` });
    }
    if (flags.length) perOwner[owner] = flags;
  }

  let flaggedOrders = 0;
  let flaggedWeight = 0n;
  let totalWeight = 0n;
  let unweighted = 0;
  const byStrength = { high: 0, medium: 0 };
  for (const o of orders) {
    const w = o.weight;
    if (w === null) unweighted += 1;
    else totalWeight += w;
    const flags = perOwner[o.owner];
    if (!flags) continue;
    flaggedOrders += 1;
    if (w !== null) flaggedWeight += w;
    byStrength[flags.some((f) => f.strength === 'high') ? 'high' : 'medium'] += 1;
  }
  return {
    cross: p.address,
    perOwner,
    flagged: { orders: flaggedOrders, ordersOfTotal: orders.length, volumeBps: totalWeight === 0n ? 0 : Number((flaggedWeight * 10_000n) / totalWeight), byStrength },
    unweightedOrders: unweighted,
    limits: [
      'Funding is traced to the first SOL a wallet received; a wallet funded through an intermediary, or one whose history was too long to read, shows no link even if one exists.',
      'A wallet that is not flagged is not proven independent.',
    ],
  };
}
