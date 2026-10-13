// Tender adapter (PRODUCT_FEATURES V4): an issuer-consented offer to buy back or sell a quantity of a token from a named set of
// holders at one price discovered in a call. Only the holders on the allowlist may place orders (a cross_gate pass); the offer
// does not print below its floor or below the minimum quantity.
//
// This is a mechanism, not legal structure. Whether, where and to whom a tender may be offered, and for how long it must stay
// open, is a question for counsel (docs/HUMAN_TASKS.md HS4), and the adapter refuses to plan one until it is told that the
// question was asked. On devnet that acknowledgement is a flag; on a real offering it is a person's decision.
import { type Address, address as toAddress } from '@solana/kit';
import { buildAllowlist } from '@opening-cross/sdk';
import type { CreateCrossRequest } from '@opening-cross/client';
import { type Plan, PlanError, randomCrossId } from './common.js';

export type TenderInput = {
  issuer: string;
  baseMint: string;
  quoteMint: string;
  baseProgram: string;
  quoteProgram: string;
  baseDecimals: number;
  now: bigint;
  /** The lowest price the issuer will accept and the highest the grid offers, in cross price units. */
  floorPrice: bigint;
  ceilingPrice: bigint;
  ticks?: number;
  /** The most base atoms the offer is for. */
  quantity: bigint;
  /** The least that must trade for the offer to print, in basis points of `quantity`. Default 5,000. */
  minFillBps?: number;
  /** Wallets that may take part. */
  holders: readonly string[];
  /** The cross_gate mint whose allowlist root this adapter prints. Defaults to the base mint. */
  gateMint?: string;
  /** How long the offer stays open, in seconds. Default seven days. */
  windowSecs?: number;
  /** The shortest window the adapter will plan. Counsel decides the real figure per jurisdiction; this is a floor on devnet runs. */
  minWindowSecs?: number;
  revealSecs?: number;
  /** Must be true: the legal questions were asked, or this is a devnet rehearsal. */
  acknowledgeNotLegalAdvice: boolean;
  integratorFeeBps?: number;
  crossId?: bigint;
};

export type TenderPlan = Plan & {
  /** What must exist before the offer can be opened: the allowlist and the gate that enforces it. */
  gate: { mint: string; holders: number; merkleRoot: string };
};

export function planTender(i: TenderInput): TenderPlan {
  if (!i.acknowledgeNotLegalAdvice) {
    throw new PlanError('a tender is a securities question before it is a mechanism (docs/HUMAN_TASKS.md HS4): pass acknowledgeNotLegalAdvice only once counsel has been asked, or for a devnet rehearsal');
  }
  if (i.holders.length === 0) throw new PlanError('a tender needs at least one eligible holder');
  const unique = [...new Set(i.holders)];
  if (unique.length !== i.holders.length) throw new PlanError(`the holder list repeats ${i.holders.length - unique.length} address(es)`);
  const ticks = i.ticks ?? 41;
  if (i.ceilingPrice <= i.floorPrice) throw new PlanError('the ceiling must be above the floor');
  if (i.quantity <= 0n) throw new PlanError('the quantity must be positive');
  const windowSecs = BigInt(i.windowSecs ?? 7 * 86_400);
  const minWindow = BigInt(i.minWindowSecs ?? 7 * 86_400);
  if (windowSecs < minWindow) throw new PlanError(`the offer must stay open at least ${minWindow} seconds; ${windowSecs} was asked`);
  const tick = (i.ceilingPrice - i.floorPrice + BigInt(ticks - 2)) / BigInt(ticks - 1);
  const gateMint = i.gateMint ?? i.baseMint;
  const { root } = buildAllowlist(toAddress(gateMint) as Address, unique.map((h) => toAddress(h) as Address));
  const minFill = BigInt(i.minFillBps ?? 5_000);
  const closeTs = i.now + windowSecs;
  const revealSecs = BigInt(i.revealSecs ?? 86_400);
  const request: CreateCrossRequest = {
    creator: i.issuer,
    baseMint: i.baseMint,
    quoteMint: i.quoteMint,
    baseTokenProgram: i.baseProgram,
    quoteTokenProgram: i.quoteProgram,
    crossId: i.crossId ?? randomCrossId(),
    kind: 'tender',
    supplyMode: 'escrow',
    disclosure: 'sealed',
    minPrice: i.floorPrice,
    tick,
    ticks,
    priceScale: 10n ** BigInt(i.baseDecimals),
    openTs: i.now,
    closeTs,
    revealEndTs: closeTs + revealSecs,
    minMatched: (i.quantity * minFill + 9_999n) / 10_000n,
    maxImbalanceBps: null,
    integratorFeeBps: i.integratorFeeBps ?? 0,
    integrator: i.issuer,
    gateMint,
    shards: 4,
    maxOrders: Math.max(1_000, unique.length * 4),
    proceedsTo: i.issuer,
  };
  return {
    request,
    gate: { mint: gateMint, holders: unique.length, merkleRoot: Buffer.from(root).toString('hex') },
    warnings: [
      'The allowlist must be published as a gate with this root (cross_gate) before the offer opens; only wallets that claim a pass can place orders.',
      'The minimum window and the eligibility of each holder are legal questions the adapter cannot answer.',
    ],
    explanation: [
      `Offers to deal ${i.quantity} base atoms of ${i.baseMint} with ${unique.length} named holders in a sealed call open for ${windowSecs} seconds, plus ${revealSecs} to reveal.`,
      `One price is discovered on a grid of ${ticks} prices from ${i.floorPrice} (the floor: no order clears below it) in steps of ${tick}. Everyone filled pays it.`,
      `It prints only if at least ${request.minMatched} base atoms (${Number(minFill) / 100}% of the offer) would trade; otherwise every order is refunded in full.`,
    ],
  };
}
