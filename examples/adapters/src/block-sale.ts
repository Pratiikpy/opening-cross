// Block-sale adapter (PRODUCT_FEATURES V7): a large holder (a treasury, a vesting contract that unlocked, a fund) sells a block
// through a cross instead of hitting a pool. The reserve is the grid's lowest price, so nothing clears below it; a minimum fill
// keeps a tiny print from counting as a sale.
//
// The seller is usually a multisig. The adapter therefore builds the create as a transaction with the seller as its only
// signer and prints it for the multisig to approve (Squads takes a serialized transaction); the sell order is the second step,
// after the cross exists. Approving and executing those two transactions is the multisig members' act, not this program's.
import type { CreateCrossRequest } from '@opening-cross/client';
import { type Plan, PlanError, randomCrossId } from './common.js';

export type BlockSaleInput = {
  /** The seller: a wallet or a multisig vault address. It is the creator, the proceeds recipient and the owner of the sell order. */
  seller: string;
  baseMint: string;
  quoteMint: string;
  baseProgram: string;
  quoteProgram: string;
  baseDecimals: number;
  now: bigint;
  amount: bigint;
  /** The lowest price the seller accepts, in cross price units. */
  reservePrice: bigint;
  /** The highest price on the grid. Default four times the reserve. */
  ceilingPrice?: bigint;
  ticks?: number;
  /** The least that must sell for the sale to print, in basis points of `amount`. Default 5,000. */
  minFillBps?: number;
  windowSecs?: number;
  revealSecs?: number;
  crossId?: bigint;
};

export type BlockSalePlan = Plan & {
  /** The sell order to place once the cross exists: the whole block at the reserve, so it sells at whatever one price clears at or above it. */
  sellOrder: { side: 'sell'; price: bigint; quantity: bigint };
};

export function planBlockSale(i: BlockSaleInput): BlockSalePlan {
  if (i.amount <= 0n) throw new PlanError('the block must be at least one atom');
  if (i.reservePrice <= 0n) throw new PlanError('the reserve price must be positive');
  const ticks = i.ticks ?? 41;
  const ceiling = i.ceilingPrice ?? i.reservePrice * 4n;
  if (ceiling <= i.reservePrice) throw new PlanError('the ceiling must be above the reserve');
  const tick = (ceiling - i.reservePrice + BigInt(ticks - 2)) / BigInt(ticks - 1);
  const windowSecs = BigInt(i.windowSecs ?? 3_600);
  const revealSecs = BigInt(i.revealSecs ?? 300);
  const closeTs = i.now + windowSecs;
  const minFill = BigInt(i.minFillBps ?? 5_000);
  const request: CreateCrossRequest = {
    creator: i.seller,
    baseMint: i.baseMint,
    quoteMint: i.quoteMint,
    baseTokenProgram: i.baseProgram,
    quoteTokenProgram: i.quoteProgram,
    crossId: i.crossId ?? randomCrossId(),
    kind: 'tender',
    supplyMode: 'escrow',
    disclosure: 'sealed',
    minPrice: i.reservePrice,
    tick,
    ticks,
    priceScale: 10n ** BigInt(i.baseDecimals),
    openTs: i.now,
    closeTs,
    revealEndTs: closeTs + revealSecs,
    minMatched: (i.amount * minFill + 9_999n) / 10_000n,
    maxImbalanceBps: null,
    integratorFeeBps: 0,
    integrator: i.seller,
    shards: 4,
    maxOrders: 10_000,
    proceedsTo: i.seller,
  };
  return {
    request,
    sellOrder: { side: 'sell', price: i.reservePrice, quantity: i.amount },
    warnings: [
      'The create and the sell order are two transactions, in that order; a multisig approves each separately. The sell order escrows the whole block, so the seller must hold it when the second one executes.',
      "The block-sale kind uses the tender fee schedule (15 bps on the seller's proceeds). Buyers pay no fee.",
    ],
    explanation: [
      `Sells ${i.amount} base atoms of ${i.baseMint} in a sealed call open for ${windowSecs} seconds, with ${revealSecs} to reveal, instead of selling into a pool.`,
      `Nothing clears below the reserve ${i.reservePrice}. The grid runs from there to ${i.reservePrice + BigInt(ticks - 1) * tick} in ${ticks} steps of ${tick}; everyone who buys pays the same clearing price.`,
      `The sale prints only if at least ${request.minMatched} base atoms (${Number(minFill) / 100}% of the block) sell; otherwise the block comes back and no sale happened.`,
    ],
  };
}
