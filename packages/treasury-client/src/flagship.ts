// The parameter set a flagship real-company treasury would start from (PRODUCT_FEATURES V6/R8, ADR-0476).
//
// This is a proposal for counsel and the issuer to review, not legal advice, and no company has agreed to it. Every
// number is a choice the issuer may change before `init_ext`; after it, the program fixes them. The program itself
// refuses the unsafe corners (a quorum under 10%, a vote under three days, a withdraw-only window under 180 days).
import type { Address } from '@solana/kit';
import type { InitExtInstructionDataArgs } from './generated/instructions/initExt.js';

const DAY = 86_400n;

export type FlagshipInputs = {
  /** SAS credential and schema of the payment-processor attester that signs each round's revenue (data: a u64, layout `[3]`). */
  revenueCredential: Address;
  revenueSchema: Address;
  /** Counsel's SAS credential and schema for the IP and asset assignment attestation. */
  assignmentCredential: Address;
  assignmentSchema: Address;
  /** The share of attested revenue owed to holders, in basis points (the issuer's offering terms). */
  revenueShareBps: number;
  /** Unix time the first revenue round starts; must not be in the past. */
  revenueStart: bigint;
  /** Where unclaimed funds go after the wind-down window. Prefer a holder-controlled multisig. */
  recovery: Address;
  /** Up to four keys excluded from NAV redemption besides the treasury authority (founders, early investors). */
  insiders?: Address[];
};

export function flagshipExtParams(i: FlagshipInputs): InitExtInstructionDataArgs {
  const zero = '11111111111111111111111111111111' as Address;
  const insiders = [...(i.insiders ?? []), zero, zero, zero, zero].slice(0, 4);
  return {
    votePeriodSecs: 7n * DAY,
    timelockSecs: 2n * DAY,
    quorumBps: 2_000,
    thresholdBps: 5_000,
    maxProposalBps: 2_000,
    proposerMinBps: 100,
    minLockupSecs: 365n * DAY,
    navPeriodSecs: 30n * DAY,
    navCapBps: 1_000,
    insiders,
    streamSecs: 7n * DAY,
    revShareBps: i.revenueShareBps,
    revCredential: i.revenueCredential,
    revSchema: i.revenueSchema,
    roundSecs: 30n * DAY,
    revStart: i.revenueStart,
    payGraceSecs: 14n * DAY,
    trancheMinRevenue: 0n,
    trancheAmount: 0n,
    disclosurePeriodSecs: 35n * DAY,
    requestMinBps: 100,
    assignRequired: true,
    assignCredential: i.assignmentCredential,
    assignSchema: i.assignmentSchema,
    windowSecs: 365n * DAY,
    recovery: i.recovery,
  };
}
