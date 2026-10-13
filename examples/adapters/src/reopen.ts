// Reopen adapter (PRODUCT_FEATURES X1, V2): opens the cross that a market reopens through. Give it the time the market trades
// again (a session start from the calendar) and a reference price, and it opens a call that closes before that moment, on a
// grid centred on the reference, with the guards that keep a thin or lopsided book from printing a price.
//
// "Shadow mode first": run with --shadow and the adapter asks the cluster to simulate the create and sends nothing, which is how
// an exchange or a tokenizer would watch it for a few sessions before it carries real orders.
import type { CreateCrossRequest } from '@opening-cross/client';
import { type Plan, PlanError, gridAround, randomCrossId } from './common.js';

export type ReopenInput = {
  creator: string;
  integrator?: string;
  proceedsTo?: string;
  integratorFeeBps?: number;
  baseMint: string;
  quoteMint: string;
  baseProgram: string;
  quoteProgram: string;
  baseDecimals: number;
  /** Unix seconds now, as the cluster sees it. */
  now: bigint;
  /** When the market this cross reopens trades again. */
  sessionOpenTs: bigint;
  /** In the cross's price units: quote atoms per 10^baseDecimals base atoms. */
  referencePrice: bigint;
  /** How long orders may be placed, in seconds. Default one hour. */
  callSecs?: number;
  /** Seconds between the close of the call and the session opening, for the clear and the finalize. Default five minutes. */
  settleSecs?: number;
  halfBandBps?: number;
  ticks?: number;
  disclosure?: 'open' | 'sealed';
  /** Sealed crosses: how long after the close bids may be revealed. Default five minutes. */
  revealSecs?: number;
  minMatched?: bigint;
  /** The largest unmatched share of the long side, in basis points of the matched volume. Default 5,000. */
  maxImbalanceBps?: number;
  oracle?: { feedId: string; maxDivergenceBps: number; maxStalenessSecs: number };
  calendar?: string;
  crossId?: bigint;
};

export function planReopen(i: ReopenInput): Plan {
  const callSecs = BigInt(i.callSecs ?? 3_600);
  const settleSecs = BigInt(i.settleSecs ?? 300);
  const revealSecs = i.disclosure === 'sealed' ? BigInt(i.revealSecs ?? 300) : 0n;
  const closeTs = i.sessionOpenTs - settleSecs - revealSecs;
  if (closeTs <= i.now + 60n) {
    throw new PlanError(`the session opens at ${i.sessionOpenTs}, only ${i.sessionOpenTs - i.now} seconds away: a call needs at least ${settleSecs + revealSecs + 60n} seconds before it`);
  }
  const openTs = closeTs - callSecs > i.now ? closeTs - callSecs : i.now;
  const grid = gridAround(i.referencePrice, i.halfBandBps ?? 1_000, i.ticks ?? 41);
  const maxImb = i.maxImbalanceBps ?? 5_000;
  const request: CreateCrossRequest = {
    creator: i.creator,
    baseMint: i.baseMint,
    quoteMint: i.quoteMint,
    baseTokenProgram: i.baseProgram,
    quoteTokenProgram: i.quoteProgram,
    crossId: i.crossId ?? randomCrossId(),
    kind: 'reopen',
    supplyMode: 'escrow',
    disclosure: i.disclosure ?? 'open',
    minPrice: grid.minPrice,
    tick: grid.tick,
    ticks: grid.ticks,
    priceScale: 10n ** BigInt(i.baseDecimals),
    openTs,
    closeTs,
    revealEndTs: closeTs + revealSecs,
    referencePrice: i.referencePrice,
    minMatched: i.minMatched ?? 1n,
    maxImbalanceBps: maxImb,
    integratorFeeBps: i.integratorFeeBps ?? 0,
    integrator: i.integrator ?? i.creator,
    shards: 4,
    maxOrders: 10_000,
    proceedsTo: i.proceedsTo ?? i.creator,
    ...(i.oracle ? { oracle: i.oracle } : {}),
    ...(i.calendar ? { calendar: i.calendar } : {}),
  };
  const warnings: string[] = [];
  if (!i.oracle) warnings.push('No oracle guard: the price is bounded by the grid and the reference only. For a token with a reference market, give the feed so a cross that clears far from it does not print.');
  if (!i.calendar) warnings.push("The cross is not bound to a calendar, so the schedule is this adapter's word, not the published exchange calendar's.");
  if (i.disclosure !== 'sealed') warnings.push('Open book: bids are visible while the call runs. Use sealed to hide them until the reveal.');
  return {
    request,
    warnings,
    explanation: [
      `Opens a call for ${i.baseMint} against ${i.quoteMint} that closes at ${closeTs}, ${settleSecs + revealSecs} seconds before the market reopens at ${i.sessionOpenTs}.`,
      `Orders are accepted from ${openTs} (${closeTs - openTs} seconds). Everyone filled pays one clearing price on a grid of ${grid.ticks} prices from ${grid.minPrice} to ${grid.minPrice + BigInt(grid.ticks - 1) * grid.tick} in steps of ${grid.tick}, centred on the reference ${i.referencePrice}.`,
      `It does not print if less than ${request.minMatched} base atoms would trade or if the unmatched side would exceed ${maxImb / 100}% of the matched volume; every order is then refunded in full.`,
      'Sellers escrow their tokens and pay the fee on what is filled; buyers pay no fee.',
    ],
  };
}
