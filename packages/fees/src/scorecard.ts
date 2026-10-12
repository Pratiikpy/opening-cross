// The external-flow scorecard (PRODUCT_FEATURES Z4, Y7). The headline numbers count flow from wallets that are not
// ours. A wallet is ours when it is declared so, or when the chain shows that one of ours funded it (a test
// harness funds hundreds of throwaway wallets; none of them is a user). Everything else counts as external, and
// the report says how many external wallets were not checked for a funding link, because that is the one place a
// careful insider could still hide.
//
// Definitions, fixed here so the figure cannot drift with the data:
//   external notional    sum, over filled orders of external owners, of the quote paid (buy) or earned gross (sell)
//   external fees        fees whose payer is external: the seller of an escrow-mode fill, the issuer of a mint-mode cross
//   unique external      distinct external owners with at least one filled order
//   repeat rate          of the external owners first seen in a UTC week, the share that fill again in a later week

export const FLOW_CLASSES = ['external', 'team', 'market_maker', 'harness', 'partner'] as const;
export type FlowClass = (typeof FLOW_CLASSES)[number];

export type WalletLabel = {
  readonly address: string;
  readonly class: Exclude<FlowClass, 'external'>;
  /** declared: listed by us. funded: a labelled wallet funded this one. role: it holds a protocol role (fee recipient, our integrator key). */
  readonly source: 'declared' | 'funded' | 'role';
  readonly evidence: string;
};

export type Classification = { readonly class: FlowClass; readonly source: WalletLabel['source'] | 'default'; readonly evidence: string };

export class FlowRegistry {
  private readonly labels = new Map<string, WalletLabel>();
  /** wallet -> the address that first funded it, where known. */
  private readonly funders = new Map<string, string>();

  constructor(labels: readonly WalletLabel[] = [], funders: ReadonlyMap<string, string> | Record<string, string> = {}) {
    for (const l of labels) this.labels.set(l.address, l);
    for (const [w, f] of funders instanceof Map ? funders : Object.entries(funders)) this.funders.set(w, f);
  }

  /** Records that `funder` first funded `wallet`. */
  link(wallet: string, funder: string): void {
    this.funders.set(wallet, funder);
  }

  hasFunder(wallet: string): boolean {
    return this.funders.has(wallet);
  }

  /** Follows funding links up to `maxHops` to a labelled wallet; no link means the wallet is external. */
  classify(address: string, maxHops = 3): Classification {
    let cur = address;
    const seen = new Set<string>();
    for (let hop = 0; hop <= maxHops; hop++) {
      const l = this.labels.get(cur);
      if (l) {
        return hop === 0 ? { class: l.class, source: l.source, evidence: l.evidence } : { class: l.class, source: 'funded', evidence: `funded ${hop} hop${hop === 1 ? '' : 's'} up by ${cur} (${l.evidence})` };
      }
      seen.add(cur);
      const next = this.funders.get(cur);
      if (!next || seen.has(next)) break;
      cur = next;
    }
    return { class: 'external', source: 'default', evidence: 'no label and no funding link to a labelled wallet' };
  }
}

export type FilledOrder = {
  readonly cross: string;
  readonly owner: string;
  readonly side: 'buy' | 'sell';
  /** Quote atoms: paid by a buyer, earned gross by a seller. */
  readonly notional: bigint;
  /** Fee this order paid in escrow mode (the seller's fee); 0 for buys. */
  readonly fee: bigint;
  /** Unix seconds of the cross's finalize. */
  readonly at: number;
};

export type CrossFlow = {
  readonly cross: string;
  readonly creator: string;
  readonly supplyMode: 'escrow' | 'mint' | 'deferred-mint';
  readonly quoteMint: string;
  /** The fee rates the cross snapshotted at creation. */
  readonly protocolBps: number;
  readonly integratorBps: number;
  readonly protocolFee: bigint;
  readonly integratorFee: bigint;
  readonly at: number;
};

export type FlowTotals = { readonly notional: bigint; readonly orders: number; readonly protocolFee: bigint; readonly integratorFee: bigint };

export type Scorecard = {
  readonly definitions: Readonly<Record<string, string>>;
  readonly byClass: Readonly<Record<FlowClass, FlowTotals>>;
  readonly external: { readonly notional: bigint; readonly protocolFee: bigint; readonly integratorFee: bigint; readonly uniqueWallets: number; readonly repeatRate: { readonly cohortWallets: number; readonly returning: number } };
  /** External wallets whose funding source was never looked up. */
  readonly unchecked: number;
  readonly crosses: number;
};

const weekOf = (at: number): number => Math.floor(at / 604_800);

const zero = (): { notional: bigint; orders: number; protocolFee: bigint; integratorFee: bigint } => ({ notional: 0n, orders: 0, protocolFee: 0n, integratorFee: 0n });

export const SCORECARD_DEFINITIONS: Readonly<Record<string, string>> = {
  externalNotional: 'Quote paid by external buyers plus gross quote earned by external sellers, over filled orders.',
  externalFees: 'Fees whose payer is external: the seller in an escrow-mode fill, the issuer in a mint-mode cross.',
  uniqueExternalWallets: 'Distinct external owners with at least one filled order.',
  repeatRate: 'Of external owners first seen in a UTC week, the share that fill again in a later week.',
  external: 'Not declared ours, not a protocol role, and not funded (within three hops) by a wallet that is.',
};

/**
 * Builds the scorecard from finalized crosses and their filled orders. A fee is split protocol/integrator exactly as the
 * program split it for the cross. In escrow mode each seller's fee is attributed to the seller's class; in mint mode the
 * whole fee belongs to the issuer's class.
 */
export function buildScorecard(crosses: readonly CrossFlow[], orders: readonly FilledOrder[], registry: FlowRegistry): Scorecard {
  const by: Record<FlowClass, ReturnType<typeof zero>> = { external: zero(), team: zero(), market_maker: zero(), harness: zero(), partner: zero() };
  const crossById = new Map(crosses.map((c) => [c.cross, c]));
  const extFirstWeek = new Map<string, number>();
  const extWeeks = new Map<string, Set<number>>();
  const unchecked = new Set<string>();
  const externalWallets = new Set<string>();

  const split = (cross: CrossFlow, fee: bigint) => {
    const total = BigInt(cross.protocolBps + cross.integratorBps);
    const protocol = total === 0n ? 0n : (fee * BigInt(cross.protocolBps)) / total;
    return { protocol, integrator: fee - protocol };
  };

  for (const o of orders) {
    const c = crossById.get(o.cross);
    if (!c) continue;
    const cls = registry.classify(o.owner);
    const row = by[cls.class];
    row.notional += o.notional;
    row.orders += 1;
    if (c.supplyMode === 'escrow' && o.fee > 0n) {
      const s = split(c, o.fee);
      row.protocolFee += s.protocol;
      row.integratorFee += s.integrator;
    }
    if (cls.class === 'external') {
      externalWallets.add(o.owner);
      if (!registry.hasFunder(o.owner)) unchecked.add(o.owner);
      const w = weekOf(o.at);
      extFirstWeek.set(o.owner, Math.min(extFirstWeek.get(o.owner) ?? w, w));
      (extWeeks.get(o.owner) ?? extWeeks.set(o.owner, new Set()).get(o.owner)!).add(w);
    }
  }
  // Mint-mode fees are paid by the issuer, whatever the buyers' classes.
  for (const c of crosses) {
    if (c.supplyMode === 'escrow') continue;
    const row = by[registry.classify(c.creator).class];
    row.protocolFee += c.protocolFee;
    row.integratorFee += c.integratorFee;
  }

  // Repeat rate: cohort = external wallets by first week; returning = filled in some later week.
  const cohort = [...extFirstWeek.keys()];
  const returning = cohort.filter((w) => [...(extWeeks.get(w) ?? [])].some((k) => k > (extFirstWeek.get(w) as number))).length;
  const ext = by.external;
  const frozen = Object.fromEntries(FLOW_CLASSES.map((k) => [k, { ...by[k] }])) as Record<FlowClass, FlowTotals>;
  return {
    definitions: SCORECARD_DEFINITIONS,
    byClass: frozen,
    external: { notional: ext.notional, protocolFee: ext.protocolFee, integratorFee: ext.integratorFee, uniqueWallets: externalWallets.size, repeatRate: { cohortWallets: cohort.length, returning } },
    unchecked: unchecked.size,
    crosses: crosses.length,
  };
}
