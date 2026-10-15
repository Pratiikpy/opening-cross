// Decides the next permissionless actions for one cross from its on-chain state alone. Pure: the
// same state and clock always give the same plan, so any number of keepers can run it and the
// program's own state checks make every duplicate a harmless failure.
//
// The duties that are not about one cross's lifecycle (insider challenges that expire, locked fills that vest, recurring series, halt states)
// are planned the same way, in duties.ts.
import type { Address } from '@solana/kit';
import { type Cross, type CrossExt, CrossState, SupplyMode, drawProgress, drawPurpose } from '@opening-cross/cross-core-client';

/** What a keeper knows about an open order beyond its address: the facts that decide whether it can only be refunded. Absent facts mean "claim it". */
export type OpenOrder = {
  address: Address;
  owner: Address;
  nonce: bigint;
  side?: 'buy' | 'sell';
  /** The limit price; meaningful once the order is revealed. */
  price?: bigint;
  /** False for a sealed order that was never revealed: refunded in full. */
  revealed?: boolean;
};

/** The most refund-only orders one `push_refunds` takes (`MAX_PUSH` in programs/cross_core/src/refunds.rs). */
export const MAX_PUSH_REFUNDS = 12;

export type Action =
  | { kind: 'settle'; cross: Address } // merge every unmerged shard, then clear
  | { kind: 'draw-begin'; cross: Address; purpose: 'end' | 'extension' } // a drawn ending, lottery or extension: record the slot
  | { kind: 'draw-finish'; cross: Address } // 20+ slots later: read the seed
  | { kind: 'abandon'; cross: Address } // deferred mint never bound by its deadline
  | { kind: 'claim'; cross: Address; order: OpenOrder } // pays the fill or refunds; funds go to the owner
  | { kind: 'push-refunds'; cross: Address; orders: OpenOrder[] } // refund-only orders, up to MAX_PUSH_REFUNDS in one transaction
  | { kind: 'finalize'; cross: Address }
  | { kind: 'expire-challenge'; cross: Address; id: number; challenge: Address; challenger: Address } // the arbiter left it unanswered for 14 days
  | { kind: 'release-locked'; cross: Address; lockup: Address; owner: Address; nonce: bigint; releasable: bigint } // the vested part of a locked fill
  | { kind: 'spawn-next'; series: Address; feed: boolean } // the next cross of a recurring series, then its missing shards
  | { kind: 'sync-pause'; halt: Address; baseMint: Address; because: 'paused' | 'unpaused' } // copy the mint's pause into the halt state
  | { kind: 'observe-price'; halt: Address; baseMint: Address; priceUpdate: Address } // feed a verified Pyth update to the circuit breaker
  | { kind: 'finalize-round'; cross: Address; round: Address; baseMint: Address } // a graduation vote whose window has closed
  | { kind: 'publish-outcome'; cross: Address; round: Address } // a passed graduation vote: write the account cross_settle reads
  | { kind: 'release-listing'; cross: Address; listing: Address; lister: Address; venue: Address; bond: Address } // the bond of a listing whose cross ended well
  | { kind: 'slash-listing'; cross: Address; listing: Address; lister: Address; venue: Address; slashTo: Address; bondMint: Address; bondTokenProgram: Address; createSlashAccount: boolean } // the bond of a listing whose settlement never happened
  | { kind: 'claim-invariant'; cross: Address; bounty: Address; invariant: number; rewardMint: Address; tokenProgram: Address } // a cross account that breaks an invariant a bounty pays
  | { kind: 'check-backing'; mint: Address; verdict: 'Missing' | 'Stale' | 'Short' }; // halt an asset whose attested backing cannot be verified

/** The cross an action belongs to, when it belongs to one. */
export const crossOf = (a: Action): Address | null => ('cross' in a ? a.cross : null);

/** `code` is a stable machine-readable cause when the keeper knows one (for example a token-safety risk code such as MINT_PAUSED). */
export type Skip = { cross: Address; reason: string; code?: string };

/** What the keeper knows about the rules: the tail of the cross account (null for a cross without rules) and the current slot (null when unknown). */
export type RulesState = { ext: CrossExt | null; slot: bigint | null };

export type PlanOptions = {
  /** Batch the orders that can only be refunded into `push_refunds`. Off by default: one `claim` per order is always correct. */
  pushRefunds?: boolean;
};

/**
 * Whether an order is certain to be refunded in full, so that `push_refunds` (which refuses an order with a fill) accepts it. Exactly the cases in which the
 * program's `outcome` gives no fill: a cross that did not print; a sealed order never revealed; a buy below the clearing price or a sell above it
 * (`clearing_core::fill` returns 0 when the order does not cross, and the allocation policy only changes the marginal buys at the price itself).
 * An order the draw left out is refunded too, but the keeper cannot tell which; that order is claimed.
 */
export function refundOnly(c: Cross, o: OpenOrder): boolean {
  if (c.state === CrossState.NoPrint) return true;
  if (c.state !== CrossState.Cleared) return false;
  if (o.revealed === false) return true;
  if (o.side === undefined || o.price === undefined || c.clearing.__option !== 'Some') return false;
  const p = c.clearing.value.price;
  return o.side === 'buy' ? o.price < p : o.price > p;
}

export function plan(address: Address, c: Cross, openOrders: OpenOrder[], now: bigint, rules: RulesState = { ext: null, slot: null }, options: PlanOptions = {}): { actions: Action[]; skipped: Skip[] } {
  const actions: Action[] = [];
  const skipped: Skip[] = [];
  switch (c.state) {
    case CrossState.Live:
      if (now < c.revealEndTs) break;
      {
        // A cross whose rules call for a draw cannot clear until the draw has finished (begin, then finish 20+ slots later).
        const purpose = drawPurpose(rules.ext, c.revealEndTs, now);
        if (!purpose) {
          actions.push({ kind: 'settle', cross: address });
          break;
        }
        const x = rules.ext!;
        if (rules.slot === null) {
          skipped.push({ cross: address, reason: `the ${purpose} draw is owed and the keeper has no slot source to time it` });
          break;
        }
        const progress = drawProgress(x, rules.slot);
        if (progress === 'ready') actions.push({ kind: 'draw-finish', cross: address });
        else if (progress === 'waiting') skipped.push({ cross: address, reason: `the ${purpose} draw begun at slot ${x.draw.pendingSlot} cannot finish before slot ${x.draw.pendingSlot + 20n}` });
        else actions.push({ kind: 'draw-begin', cross: address, purpose });
      }
      break;
    case CrossState.Cleared:
      // A deferred-mint cross pays nothing until its settlement adapter binds the mint; after
      // the deadline it is abandoned and refunded instead.
      if (c.supplyMode === SupplyMode.DeferredMint && !c.baseBound) {
        if (c.settleDeadlineTs > 0n && now >= c.settleDeadlineTs) actions.push({ kind: 'abandon', cross: address });
        else skipped.push({ cross: address, reason: 'waiting for the settlement adapter to bind the base mint' });
        break;
      }
    // falls through: a cleared cross with its base mint available settles like a no-print
    case CrossState.NoPrint: {
      const batched = new Set<OpenOrder>();
      if (options.pushRefunds) {
        const only = openOrders.filter((o) => refundOnly(c, o));
        // A group of one is a plain claim; a group is one transaction instead of one per order.
        for (let i = 0; i + 2 <= only.length; i += MAX_PUSH_REFUNDS) {
          const group = only.slice(i, i + MAX_PUSH_REFUNDS);
          if (group.length < 2) break;
          group.forEach((o) => batched.add(o));
          actions.push({ kind: 'push-refunds', cross: address, orders: group });
        }
      }
      for (const order of openOrders) if (!batched.has(order)) actions.push({ kind: 'claim', cross: address, order });
      if (openOrders.length === 0 && c.ordersOpen === 0) {
        // `finalize` returns the insiders' bond with the proceeds only after the challenge window, and not while a challenge is open.
        const x = rules.ext;
        if (c.state === CrossState.Cleared && x && x.neutrality.bondQuote > 0n && x.neutralState.openChallenges > 0) {
          skipped.push({ cross: address, code: 'CHALLENGE_OPEN', reason: `${x.neutralState.openChallenges} insider challenge(s) are open: the arbiter rules on them, or anyone closes one 14 days after it was filed` });
        } else if (c.state === CrossState.Cleared && x && x.neutrality.bondQuote > 0n && now < x.clearing.clearedTs + BigInt(x.neutrality.challengeSecs)) {
          skipped.push({ cross: address, code: 'CHALLENGE_WINDOW', reason: `the insider challenge window is open until ${x.clearing.clearedTs + BigInt(x.neutrality.challengeSecs)}` });
        } else actions.push({ kind: 'finalize', cross: address });
      } else if (openOrders.length !== c.ordersOpen) {
        skipped.push({ cross: address, reason: `order discovery found ${openOrders.length} of ${c.ordersOpen} open orders` });
      }
      break;
    }
    case CrossState.Finalized:
      break;
  }
  return { actions, skipped };
}
