// Measured protocol metrics (execution quality, fairness, external flow).
//
// Everything here is computed from what the indexer stored (orders, clearing, event times) plus
// the immutable fields of each cross account (price scale, creator, integrator, gate), read from
// chain once and kept. Nothing is estimated, defaulted or assumed: a quantity with no data is
// null, and every figure travels with its sample size and a one-line method statement.
//
// The functions in the first half are pure (no database, no chain) so they can be tested with
// hand-built crosses; `loadCrossFacts` at the bottom is the only part that reads anything.
import type pg from 'pg';
import { type Address } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, Disclosure, getCrossDecoder } from '@opening-cross/sdk';
import { wilson } from '@opening-cross/promises';

// ---------------------------------------------------------------- inputs

/** Fields of a cross account that never change after creation. */
export type CrossStatics = {
  priceScale: bigint;
  quoteDecimals: number;
  baseDecimals: number;
  creator: string;
  proceedsTo: string;
  integrator: string;
  feeRecipient: string;
  /** Mint a bidder must hold to enter, or null when the cross is open to any wallet. */
  gateMint: string | null;
  sealed: boolean;
};

export type OrderFact = {
  owner: string;
  side: 'buy' | 'sell';
  escrow: bigint;
  /** The order's limit price; null while a sealed order is unrevealed (and forever if it never reveals). */
  price: bigint | null;
  quantity: bigint | null;
  /** committed | revealed | cancelled | claimed (the indexer's status). */
  status: string;
  fill: bigint | null;
  quoteOut: bigint | null;
};

export type CrossFact = {
  address: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  closeTs: number;
  clearingPrice: bigint | null;
  matched: bigint | null;
  /** Block time (unix seconds) of the CrossCleared / CrossFinalized events; null when the RPC gave none. */
  clearedAt: number | null;
  finalizedAt: number | null;
  statics: CrossStatics;
  orders: OrderFact[];
};

// ---------------------------------------------------------------- small exact helpers

/** Nearest-rank quantile (p in [0,1]) of a sample; null for an empty sample. */
export function quantile<T extends number | bigint>(xs: readonly T[], p: number): T | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** a / b as a number rounded (half up) to 6 decimals, for ratios of two bigints. */
const ratio = (a: bigint, b: bigint): number | null => (b === 0n ? null : Number((a * 2_000_000n + b) / (2n * b)) / 1_000_000);
const median = <T extends number | bigint>(xs: readonly T[]) => quantile(xs, 0.5);
const str = (x: bigint | null) => (x === null ? null : x.toString());

const isPrinted = (c: CrossFact) => c.state === 'Finalized' && c.clearingPrice !== null && c.clearingPrice > 0n;

// ---------------------------------------------------------------- Y2: execution quality

export const EXECUTION_METHOD =
  'Over every Finalized cross that printed. Fill rate is bids that received any fill divided by bids placed (cancelled and unrevealed bids count as placed). ' +
  'Price improvement of a filled bid is its own limit price minus the single clearing price it paid, as basis points of the limit and as quote atoms ' +
  '(ceil(fill x limit / price scale) minus the quote actually paid); quantiles are nearest-rank. Refund share is, per cross, the share of bid escrow returned to ' +
  'bidders (the refund on claim plus escrow returned on cancel). Time is from the cross\'s close timestamp to the block time of its CrossCleared / CrossFinalized event, ' +
  'so a sealed cross includes its reveal window. Quote atoms are not summed across crosses because their quote mints differ.';

export type ExecutionQuality = {
  method: string;
  /** Finalized crosses with a print: the sample every figure below is drawn from. */
  crosses: number;
  /** Finalized crosses with no print, left out of the sample. */
  finalizedWithoutPrint: number;
  bids: {
    placed: number;
    filled: number;
    /** filled / placed; null when no bid was placed. */
    fillRate: number | null;
    fullyFilled: number;
    partiallyFilled: number;
    /** Revealed bids priced below the clearing price: no fill. */
    notFilledPricedOut: number;
    cancelled: number;
    /** Sealed bids never revealed. */
    unrevealed: number;
    /** Bids in none of the above states (should be 0; non-zero means the index is behind the chain). */
    unaccounted: number;
  };
  priceImprovement: {
    /** Filled bids the figures cover. */
    filledBids: number;
    /** Filled bids whose limit equalled the clearing price (no improvement possible). */
    atClearingPrice: number;
    bps: { median: number | null; p10: number | null };
    quoteAtoms: { median: string | null; p10: string | null; quoteDecimals: number[] };
    /** Bids whose recorded quote paid exceeded the cost at their own limit: a data fault, expected 0. */
    inconsistent: number;
  };
  refundShare: {
    /** Crosses with at least one bid. */
    crosses: number;
    median: number | null;
    min: number | null;
    max: number | null;
  };
  closeToFinalizedSeconds: { n: number; median: number | null; p90: number | null; max: number | null; excluded: number };
  closeToClearedSeconds: { n: number; median: number | null; p90: number | null; max: number | null; excluded: number };
};

function latency(values: (number | null)[]) {
  const ok = values.filter((v): v is number => v !== null && v >= 0);
  return { n: ok.length, median: median(ok), p90: quantile(ok, 0.9), max: ok.length ? Math.max(...ok) : null, excluded: values.length - ok.length };
}

export function executionQuality(all: readonly CrossFact[]): ExecutionQuality {
  const crosses = all.filter(isPrinted);
  const bids = { placed: 0, filled: 0, fullyFilled: 0, partiallyFilled: 0, notFilledPricedOut: 0, cancelled: 0, unrevealed: 0, unaccounted: 0 };
  const bps: number[] = [];
  const atoms: bigint[] = [];
  const decimals = new Set<number>();
  let atClearing = 0;
  let inconsistent = 0;
  const refunds: number[] = [];

  for (const c of crosses) {
    const clearing = c.clearingPrice!;
    let escrowed = 0n;
    let returned = 0n;
    let bidsInCross = 0;
    for (const o of c.orders) {
      if (o.side !== 'buy') continue;
      bids.placed++;
      bidsInCross++;
      escrowed += o.escrow;
      if (o.status === 'cancelled') {
        bids.cancelled++;
        returned += o.escrow;
        continue;
      }
      if (o.status !== 'claimed') {
        bids.unaccounted++;
        continue;
      }
      returned += o.quoteOut ?? 0n;
      const fill = o.fill ?? 0n;
      if (o.price === null) {
        // A sealed bid with no revealed price can only have been refunded; one that was filled anyway means the index missed its reveal.
        if (fill > 0n) bids.unaccounted++;
        else bids.unrevealed++;
        continue;
      }
      if (fill === 0n) {
        bids.notFilledPricedOut++;
        continue;
      }
      bids.filled++;
      if (o.quantity !== null && fill >= o.quantity) bids.fullyFilled++;
      else bids.partiallyFilled++;
      // What the bid paid is what was not refunded; what it would have paid at its own limit is exact from the scale.
      const paid = o.escrow - (o.quoteOut ?? 0n);
      const atLimit = ceilDiv(fill * o.price, c.statics.priceScale);
      const improvement = atLimit - paid;
      if (improvement < 0n || o.price < clearing) {
        inconsistent++;
        continue;
      }
      if (o.price === clearing) atClearing++;
      bps.push(Number(((o.price - clearing) * 10_000n * 100n) / o.price) / 100);
      atoms.push(improvement);
      decimals.add(c.statics.quoteDecimals);
    }
    if (bidsInCross > 0 && escrowed > 0n) refunds.push(ratio(returned, escrowed)!);
  }

  return {
    method: EXECUTION_METHOD,
    crosses: crosses.length,
    finalizedWithoutPrint: all.filter((c) => c.state === 'Finalized' && !isPrinted(c)).length,
    bids: { ...bids, fillRate: bids.placed ? bids.filled / bids.placed : null },
    priceImprovement: {
      filledBids: bps.length,
      atClearingPrice: atClearing,
      bps: { median: median(bps), p10: quantile(bps, 0.1) },
      quoteAtoms: { median: str(median(atoms)), p10: str(quantile(atoms, 0.1)), quoteDecimals: [...decimals].sort((a, b) => a - b) },
      inconsistent,
    },
    refundShare: { crosses: refunds.length, median: median(refunds), min: refunds.length ? Math.min(...refunds) : null, max: refunds.length ? Math.max(...refunds) : null },
    closeToFinalizedSeconds: latency(crosses.map((c) => (c.finalizedAt === null ? null : c.finalizedAt - c.closeTs))),
    closeToClearedSeconds: latency(crosses.map((c) => (c.clearedAt === null ? null : c.clearedAt - c.closeTs))),
  };
}

// ---------------------------------------------------------------- F1: fairness

export const FAIRNESS_METHOD =
  'Over every Finalized cross that printed. Cluster share is the fraction of one side\'s filled base quantity taken by its largest 1, 5 and 10 wallets, ' +
  'measured per wallet address; wallets are not linked to each other or to people, so one actor using many wallets would look more dispersed than it is. ' +
  'A top-N share is trivially 100% when a side has N or fewer wallets, so the aggregate medians use only crosses with more than N filled wallets on that side. ' +
  'The proportion with a Wilson 95% interval is taken over crosses (the sample unit), not over orders. The identity count is the number of distinct bidding wallets; ' +
  'on a gated cross every bidder passed the gate to place an order, but a gate credential is not proof of one person per wallet.';

export type SideShare = { wallets: number; top1: number | null; top5: number | null; top10: number | null };

export type CrossFairness = {
  address: string;
  /** Distinct wallets that placed a bid (any outcome). */
  bidders: number;
  /** Distinct wallets that placed an ask. */
  sellers: number;
  /** Distinct wallets on either side. */
  wallets: number;
  buy: SideShare;
  sell: SideShare;
  /** Wallets that hold fills on both sides of this cross (a wallet trading against itself). */
  bothSides: number;
  identity: { count: number; basis: 'gate-passing wallets' | 'wallets, not people'; gated: boolean };
};

export type Fairness = {
  method: string;
  crosses: number;
  threshold: number;
  /** Crosses where the largest filled buyer took more than `threshold` of the buy-side fill, over crosses with a filled buyer. */
  topBuyerAboveThreshold: { k: number; n: number; proportion: number | null; wilsonLo: number | null; wilsonHi: number | null };
  /** Medians over crosses with strictly more filled wallets on the side than N (so the share is not trivially 100%). */
  medianBuySide: { top1: number | null; top5: number | null; top10: number | null; crossesOver1: number; crossesOver5: number; crossesOver10: number };
  crossesWithSelfCross: number;
  wallets: { distinctAcrossCrosses: number; medianBiddersPerCross: number | null; maxBiddersInACross: number | null };
  perCross: CrossFairness[];
};

function sideShare(orders: OrderFact[], side: 'buy' | 'sell'): SideShare & { filled: bigint } {
  const byWallet = new Map<string, bigint>();
  for (const o of orders) if (o.side === side && o.fill && o.fill > 0n) byWallet.set(o.owner, (byWallet.get(o.owner) ?? 0n) + o.fill);
  const volumes = [...byWallet.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const total = volumes.reduce((s, v) => s + v, 0n);
  const top = (n: number) => (total === 0n ? null : ratio(volumes.slice(0, n).reduce((s, v) => s + v, 0n), total));
  return { wallets: volumes.length, top1: top(1), top5: top(5), top10: top(10), filled: total };
}

export function crossFairness(c: CrossFact): CrossFairness {
  const bidders = new Set(c.orders.filter((o) => o.side === 'buy').map((o) => o.owner));
  const sellers = new Set(c.orders.filter((o) => o.side === 'sell').map((o) => o.owner));
  const buy = sideShare(c.orders, 'buy');
  const sell = sideShare(c.orders, 'sell');
  const filledBuyers = new Set(c.orders.filter((o) => o.side === 'buy' && o.fill && o.fill > 0n).map((o) => o.owner));
  const filledSellers = new Set(c.orders.filter((o) => o.side === 'sell' && o.fill && o.fill > 0n).map((o) => o.owner));
  const gated = c.statics.gateMint !== null;
  const { filled: _b, ...b } = buy;
  const { filled: _s, ...s } = sell;
  return {
    address: c.address,
    bidders: bidders.size,
    sellers: sellers.size,
    wallets: new Set([...bidders, ...sellers]).size,
    buy: b,
    sell: s,
    bothSides: [...filledBuyers].filter((w) => filledSellers.has(w)).length,
    identity: { count: bidders.size, basis: gated ? 'gate-passing wallets' : 'wallets, not people', gated },
  };
}

export function fairness(all: readonly CrossFact[], threshold = 0.1): Fairness {
  const crosses = all.filter(isPrinted);
  const per = crosses.map(crossFairness);
  const withBuyer = per.filter((p) => p.buy.top1 !== null);
  const k = withBuyer.filter((p) => p.buy.top1! > threshold).length;
  const w = wilson(k, withBuyer.length);
  const over = (n: 1 | 5 | 10) => per.filter((p) => p.buy.wallets > n && p.buy[`top${n}` as const] !== null);
  const med = (n: 1 | 5 | 10) => median(over(n).map((p) => p.buy[`top${n}` as const]!));
  const distinct = new Set<string>();
  for (const c of crosses) for (const o of c.orders) if (o.side === 'buy') distinct.add(o.owner);
  const bidderCounts = per.map((p) => p.bidders);
  return {
    method: FAIRNESS_METHOD,
    crosses: crosses.length,
    threshold,
    topBuyerAboveThreshold: { k, n: withBuyer.length, proportion: withBuyer.length ? k / withBuyer.length : null, wilsonLo: withBuyer.length ? w.lo : null, wilsonHi: withBuyer.length ? w.hi : null },
    medianBuySide: { top1: med(1), top5: med(5), top10: med(10), crossesOver1: over(1).length, crossesOver5: over(5).length, crossesOver10: over(10).length },
    crossesWithSelfCross: per.filter((p) => p.bothSides > 0).length,
    wallets: { distinctAcrossCrosses: distinct.size, medianBiddersPerCross: median(bidderCounts), maxBiddersInACross: bidderCounts.length ? Math.max(...bidderCounts) : null },
    perCross: per,
  };
}

// ---------------------------------------------------------------- Z4 / Y7: external flow

export const EXTERNAL_FLOW_METHOD =
  'Over every cross that has at least one order, in any state. A wallet counts as own on a cross when it is in OWN_WALLETS or is that cross\'s creator, proceeds recipient, ' +
  'integrator or protocol fee recipient. A wallet is own overall only if it is own on every cross it appears in; otherwise it is external. ' +
  'Any wallet we operate that is neither listed nor one of those roles (throwaway test wallets created on the fly, for instance) is still counted as external, ' +
  'so the external figures are an upper bound on outside users, loosest when OWN_WALLETS is unset. Wallets are addresses, not people.';

export type ExternalFlow = {
  method: string;
  /** Number of addresses in OWN_WALLETS (0 when unset: see the method line). */
  ownWalletsConfigured: number;
  network: string;
  crosses: { withOrders: number; withAnExternalWallet: number; onlyOwnWallets: number };
  wallets: { total: number; own: number; external: number; externalShare: number | null };
  /** Wallets that received a fill on at least one cross. */
  filledWallets: { total: number; own: number; external: number };
  orders: { total: number; byExternal: number; filled: number; filledByExternal: number };
  /** What the figures support saying. External here only ever means "not known to be ours", an upper bound on outside users. */
  verdict: 'no external wallets seen' | 'external wallets seen, ownership list not configured (upper bound)' | 'external wallets seen, not known to be ours (upper bound on outside users)';
};

export function externalFlow(all: readonly CrossFact[], own: ReadonlySet<string>, network: string): ExternalFlow {
  const withOrders = all.filter((c) => c.orders.length > 0);
  const isOwn = (c: CrossFact, w: string) => own.has(w) || w === c.statics.creator || w === c.statics.proceedsTo || w === c.statics.integrator || w === c.statics.feeRecipient;
  const everExternal = new Set<string>();
  const seen = new Set<string>();
  const filledSeen = new Set<string>();
  const filledExternal = new Set<string>();
  const orders = { total: 0, byExternal: 0, filled: 0, filledByExternal: 0 };
  let crossesExternal = 0;
  for (const c of withOrders) {
    let any = false;
    for (const o of c.orders) {
      const ext = !isOwn(c, o.owner);
      seen.add(o.owner);
      orders.total++;
      if (ext) {
        orders.byExternal++;
        everExternal.add(o.owner);
        any = true;
      }
      if (o.fill && o.fill > 0n) {
        orders.filled++;
        filledSeen.add(o.owner);
        if (ext) {
          orders.filledByExternal++;
          filledExternal.add(o.owner);
        }
      }
    }
    if (any) crossesExternal++;
  }
  const filledExt = [...filledSeen].filter((w) => filledExternal.has(w)).length;
  const verdict = everExternal.size === 0 ? 'no external wallets seen' : own.size === 0 ? 'external wallets seen, ownership list not configured (upper bound)' : 'external wallets seen, not known to be ours (upper bound on outside users)';
  return {
    method: EXTERNAL_FLOW_METHOD,
    ownWalletsConfigured: own.size,
    network,
    crosses: { withOrders: withOrders.length, withAnExternalWallet: crossesExternal, onlyOwnWallets: withOrders.length - crossesExternal },
    wallets: { total: seen.size, own: seen.size - everExternal.size, external: everExternal.size, externalShare: seen.size ? everExternal.size / seen.size : null },
    filledWallets: { total: filledSeen.size, own: filledSeen.size - filledExt, external: filledExt },
    orders,
    verdict,
  };
}

/** Parses OWN_WALLETS (comma or whitespace separated base58 addresses). Anything that is not an address is rejected, not skipped. */
export function parseOwnWallets(raw: string | undefined, isAddr: (s: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    if (!isAddr(part)) throw new Error(`OWN_WALLETS contains a value that is not a Solana address: ${part.slice(0, 12)}`);
    out.add(part);
  }
  return out;
}

// ---------------------------------------------------------------- loading

type Account = { data: Uint8Array; owner: Address } | null;

/**
 * Reads the facts for every cross with orders. The immutable account fields are read from chain
 * once per cross and kept; a cross that cannot be read fails the whole call rather than being
 * left out, so a figure never silently covers fewer crosses than it claims.
 */
export function createFactsLoader(db: pg.Pool, account: (a: Address) => Promise<Account>) {
  const statics = new Map<string, CrossStatics>();

  async function staticsOf(a: string): Promise<CrossStatics> {
    const hit = statics.get(a);
    if (hit) return hit;
    const kept = (await db.query('SELECT * FROM cross_statics WHERE address = $1', [a])).rows[0];
    if (kept) {
      const s: CrossStatics = {
        priceScale: BigInt(kept.price_scale),
        quoteDecimals: kept.quote_decimals,
        baseDecimals: kept.base_decimals,
        creator: kept.creator,
        proceedsTo: kept.proceeds_to,
        integrator: kept.integrator,
        feeRecipient: kept.fee_recipient,
        gateMint: kept.gate_mint,
        sealed: kept.sealed,
      };
      statics.set(a, s);
      return s;
    }
    // The public cluster endpoint answers 429 under bursts; a few spaced retries keep a cold start from failing the whole request.
    let acct: Account = null;
    for (let attempt = 0; ; attempt++) {
      try {
        acct = await account(a as Address);
        break;
      } catch (e) {
        if (attempt >= 4 || !/429|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) {
      throw new Error(`cross ${a} could not be read from chain (fetch failed)`);
    }
    const c = getCrossDecoder().decode(acct.data);
    const s: CrossStatics = {
      priceScale: c.priceScale,
      quoteDecimals: c.quoteDecimals,
      baseDecimals: c.baseDecimals,
      creator: c.creator,
      proceedsTo: c.proceedsTo,
      integrator: c.integrator,
      feeRecipient: c.feeRecipient,
      gateMint: c.gateMint.__option === 'Some' ? c.gateMint.value : null,
      sealed: c.disclosure === Disclosure.Sealed,
    };
    statics.set(a, s);
    await db.query(
      `INSERT INTO cross_statics (address, price_scale, quote_decimals, base_decimals, creator, proceeds_to, integrator, fee_recipient, gate_mint, sealed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (address) DO NOTHING`,
      [a, s.priceScale.toString(), s.quoteDecimals, s.baseDecimals, s.creator, s.proceedsTo, s.integrator, s.feeRecipient, s.gateMint, s.sealed],
    );
    return s;
  }

  return async function load(opts: { states: readonly string[]; address?: string }): Promise<CrossFact[]> {
    const crossRows = (
      await db.query(
        `SELECT c.address, c.state, c.close_ts, c.clearing_price, c.matched,
                (SELECT extract(epoch FROM min(e.block_time)) FROM events e WHERE e.cross_address = c.address AND e.name = 'CrossCleared') AS cleared_at,
                (SELECT extract(epoch FROM min(e.block_time)) FROM events e WHERE e.cross_address = c.address AND e.name = 'CrossFinalized') AS finalized_at
         FROM crosses c WHERE c.state = ANY($1::text[]) AND ($2::text IS NULL OR c.address = $2) AND EXISTS (SELECT 1 FROM orders o WHERE o.cross_address = c.address) ORDER BY c.created_slot`,
        [opts.states, opts.address ?? null],
      )
    ).rows;
    const orderRows = (
      await db.query(
        `SELECT cross_address, owner, side, escrow, price, quantity, status, fill, quote_out FROM orders WHERE cross_address = ANY($1::text[]) ORDER BY cross_address, idx`,
        [crossRows.map((r) => r.address)],
      )
    ).rows;
    const byCross = new Map<string, OrderFact[]>();
    const big = (x: string | null) => (x === null ? null : BigInt(x));
    for (const r of orderRows) {
      const list = byCross.get(r.cross_address) ?? [];
      list.push({ owner: r.owner, side: r.side === 0 ? 'buy' : 'sell', escrow: BigInt(r.escrow), price: big(r.price), quantity: big(r.quantity), status: r.status, fill: big(r.fill), quoteOut: big(r.quote_out) });
      byCross.set(r.cross_address, list);
    }
    const facts: CrossFact[] = [];
    // A few chain reads at a time: the first call after a restart reads each cross once, later calls read none.
    for (let i = 0; i < crossRows.length; i += 4) {
      const slice = crossRows.slice(i, i + 4);
      const st = await Promise.all(slice.map((r) => staticsOf(r.address)));
      slice.forEach((r, j) =>
        facts.push({
          address: r.address,
          state: r.state,
          closeTs: Number(r.close_ts),
          clearingPrice: big(r.clearing_price),
          matched: big(r.matched),
          clearedAt: r.cleared_at === null ? null : Math.floor(Number(r.cleared_at)),
          finalizedAt: r.finalized_at === null ? null : Math.floor(Number(r.finalized_at)),
          statics: st[j]!,
          orders: byCross.get(r.address) ?? [],
        }),
      );
    }
    return facts;
  };
}
