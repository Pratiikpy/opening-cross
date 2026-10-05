// Decides the next permissionless actions for one cross from its on-chain state alone. Pure: the
// same state and clock always give the same plan, so any number of keepers can run it and the
// program's own state checks make every duplicate a harmless failure.
import type { Address } from '@solana/kit';
import { type Cross, CrossState, SupplyMode } from '@opening-cross/cross-core-client';

export type OpenOrder = { address: Address; owner: Address; nonce: bigint };

export type Action =
  | { kind: 'settle'; cross: Address } // merge every unmerged shard, then clear
  | { kind: 'abandon'; cross: Address } // deferred mint never bound by its deadline
  | { kind: 'claim'; cross: Address; order: OpenOrder } // pays the fill or refunds; funds go to the owner
  | { kind: 'finalize'; cross: Address };

export type Skip = { cross: Address; reason: string };

export function plan(address: Address, c: Cross, openOrders: OpenOrder[], now: bigint): { actions: Action[]; skipped: Skip[] } {
  const actions: Action[] = [];
  const skipped: Skip[] = [];
  switch (c.state) {
    case CrossState.Live:
      if (now >= c.revealEndTs) actions.push({ kind: 'settle', cross: address });
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
