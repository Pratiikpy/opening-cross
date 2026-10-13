// Decides the next permissionless actions for one cross from its on-chain state alone. Pure: the
// same state and clock always give the same plan, so any number of keepers can run it and the
// program's own state checks make every duplicate a harmless failure.
import type { Address } from '@solana/kit';
import { type Cross, type CrossExt, CrossState, SupplyMode, drawProgress, drawPurpose } from '@opening-cross/cross-core-client';

export type OpenOrder = { address: Address; owner: Address; nonce: bigint };

export type Action =
  | { kind: 'settle'; cross: Address } // merge every unmerged shard, then clear
  | { kind: 'draw-begin'; cross: Address; purpose: 'end' | 'extension' } // a drawn ending, lottery or extension: record the slot
  | { kind: 'draw-finish'; cross: Address } // 20+ slots later: read the seed
  | { kind: 'abandon'; cross: Address } // deferred mint never bound by its deadline
  | { kind: 'claim'; cross: Address; order: OpenOrder } // pays the fill or refunds; funds go to the owner
  | { kind: 'finalize'; cross: Address };

/** `code` is a stable machine-readable cause when the keeper knows one (for example a token-safety risk code such as MINT_PAUSED). */
export type Skip = { cross: Address; reason: string; code?: string };

/** What the keeper knows about the rules: the tail of the cross account (null for a cross without rules) and the current slot (null when unknown). */
export type RulesState = { ext: CrossExt | null; slot: bigint | null };

export function plan(address: Address, c: Cross, openOrders: OpenOrder[], now: bigint, rules: RulesState = { ext: null, slot: null }): { actions: Action[]; skipped: Skip[] } {
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
    case CrossState.NoPrint:
      for (const order of openOrders) actions.push({ kind: 'claim', cross: address, order });
      if (openOrders.length === 0 && c.ordersOpen === 0) actions.push({ kind: 'finalize', cross: address });
      else if (openOrders.length !== c.ordersOpen) {
        skipped.push({ cross: address, reason: `order discovery found ${openOrders.length} of ${c.ordersOpen} open orders` });
      }
      break;
    case CrossState.Finalized:
      break;
  }
  return { actions, skipped };
}
