// Builders for `cross_bounty` (X10; ADR-0654): a pool committed for at least thirty days that pays automatically, once per invariant, to whoever shows a
// cross account that breaks one of eleven invariants, and by a named arbiter for what the chain cannot check. The sponsor can withdraw only after the expiry.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  type Bounty,
  CROSS_BOUNTY_PROGRAM_ADDRESS,
  findBountyPda,
  getAwardInstruction,
  getClaimInvariantInstruction,
  getCreateBountyInstruction,
  getFundInstruction,
  getWithdrawInstruction,
} from '@opening-cross/cross-bounty-client';
import { type Cross, CrossState, SupplyMode, ata } from '../index.js';
import { type ProgramIssue, createAtaIdempotent, refuse } from './common.js';

export { CROSS_BOUNTY_PROGRAM_ADDRESS };
export type { Bounty };

/** Invariants the program checks; an id is a position in `Bounty.rewards`. */
export const BOUNTY_INVARIANTS = 11;
/** The shortest commitment a bounty may make: thirty days (the program's `MIN_COMMITMENT_SECS`). */
export const BOUNTY_MIN_COMMITMENT_SECS = 30n * 86_400n;

/** The eleven invariants, in the program's order. */
export const BOUNTY_INVARIANT_NAMES: readonly string[] = [
  'more orders open than were ever placed',
  'cleared with no clearing summary',
  'did not print with no reason',
  'finalized with an order still open',
  'a clearing price off the cross grid',
  'a fee above the protocol caps',
  'matched volume above the recorded demand or supply',
  'sellers paid more than buyers paid plus the quote value of the undelivered base',
  'a clearing summary or a no-print reason on a cross still taking orders',
  'buyers took more base than sellers delivered',
  'buyers took more base than the clear matched',
];

const MAX_FEE_BPS_PROTOCOL = 100;
const MAX_FEE_BPS_INTEGRATOR = 300;

/** Whether `price` is `min + i x tick` for some `i < ticks`. */
export const onGrid = (price: bigint, min: bigint, tick: bigint, ticks: number): boolean => {
  if (price < min || tick === 0n) return false;
  const offset = price - min;
  return offset % tick === 0n && offset / tick < BigInt(ticks);
};

type CrossFacts = Pick<Cross, 'state' | 'ordersOpen' | 'ordersTotal' | 'clearing' | 'noPrintReason' | 'minPrice' | 'tick' | 'ticks' | 'protocolFeeBps' | 'integratorFeeBps' | 'supplyMode' | 'baseSold' | 'baseBought' | 'sellerPaid' | 'buyerPaid' | 'priceScale'>;

/** Whether a cross account is in a state `cross_core` promises never to produce: `violates` of the program, id for id. */
export function crossViolates(invariant: number, c: CrossFacts): boolean {
  const live = c.state === CrossState.Live;
  const cleared = c.state === CrossState.Cleared;
  const done = c.state === CrossState.Cleared || c.state === CrossState.Finalized;
  const clearing = c.clearing.__option === 'Some' ? c.clearing.value : null;
  switch (invariant) {
    case 0:
      return c.ordersOpen > c.ordersTotal;
    case 1:
      return cleared && clearing === null;
    case 2:
      return c.state === CrossState.NoPrint && c.noPrintReason.__option === 'None';
    case 3:
      return c.state === CrossState.Finalized && c.ordersOpen !== 0;
    case 4:
      return cleared && clearing !== null && !onGrid(clearing.price, c.minPrice, c.tick, c.ticks);
    case 5:
      return c.protocolFeeBps > MAX_FEE_BPS_PROTOCOL || c.integratorFeeBps > MAX_FEE_BPS_INTEGRATOR;
    case 6:
      return done && clearing !== null && clearing.matched > (clearing.demand < clearing.supply ? clearing.demand : clearing.supply);
    case 7: {
      if (!(done && c.ordersOpen === 0 && c.supplyMode === SupplyMode.Escrow && clearing !== null)) return false;
      const undelivered = c.baseSold > c.baseBought ? c.baseSold - c.baseBought : 0n;
      const dust = (undelivered * clearing.price) / (c.priceScale > 1n ? c.priceScale : 1n);
      return c.sellerPaid > c.buyerPaid + dust;
    }
    case 8:
      return live && (clearing !== null || c.noPrintReason.__option === 'Some');
    case 9:
      return done && c.ordersOpen === 0 && c.supplyMode === SupplyMode.Escrow && c.baseBought > c.baseSold;
    case 10:
      return done && c.ordersOpen === 0 && clearing !== null && c.baseBought > clearing.matched;
    default:
      return false;
  }
}

/** Every invariant a cross account breaks right now (empty for any honest cross). */
export function brokenInvariants(c: CrossFacts): number[] {
  return Array.from({ length: BOUNTY_INVARIANTS }, (_, i) => i).filter((i) => crossViolates(i, c));
}

export function checkBountyTerms(rewards: readonly bigint[], expiresAt: bigint, now: bigint): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (rewards.length !== BOUNTY_INVARIANTS) out.push({ code: 'BadRewards', field: 'rewards', message: `give a reward for each of the ${BOUNTY_INVARIANTS} invariants (0 leaves one out)` });
  if (expiresAt < now + BOUNTY_MIN_COMMITMENT_SECS) out.push({ code: 'CommitmentTooShort', field: 'expiresAt', message: 'a bounty commits its pool for at least thirty days' });
  return out;
}

export async function bountyAddresses(sponsor: Address, id: bigint, rewardMint: Address, tokenProgram: Address): Promise<{ bounty: Address; vault: Address }> {
  const [bounty] = await findBountyPda({ sponsor, id });
  return { bounty, vault: await ata(bounty, rewardMint, tokenProgram) };
}

/** `create_bounty`: the terms never change. */
export async function buildCreateBounty(input: { sponsor: TransactionSigner; id: bigint; rewardMint: Address; tokenProgram: Address; arbiter: Address; expiresAt: bigint; rewards: readonly bigint[]; now?: bigint }): Promise<{ instruction: Instruction; bounty: Address; vault: Address }> {
  refuse(checkBountyTerms(input.rewards, input.expiresAt, input.now ?? BigInt(Math.floor(Date.now() / 1000))));
  const a = await bountyAddresses(input.sponsor.address, input.id, input.rewardMint, input.tokenProgram);
  const instruction = getCreateBountyInstruction({ sponsor: input.sponsor, rewardMint: input.rewardMint, bounty: a.bounty, vault: a.vault, tokenProgram: input.tokenProgram, id: input.id, arbiter: input.arbiter, expiresAt: input.expiresAt, rewards: [...input.rewards] });
  return { instruction, ...a };
}

export async function buildFundBounty(input: { funder: TransactionSigner; bounty: Address; vault: Address; rewardMint: Address; tokenProgram: Address; amount: bigint }): Promise<Instruction> {
  refuse(input.amount > 0n ? [] : [{ code: 'NothingToDo', field: 'amount', message: 'fund a positive amount' }]);
  return getFundInstruction({ funder: input.funder, bounty: input.bounty, rewardMint: input.rewardMint, funderToken: await ata(input.funder.address, input.rewardMint, input.tokenProgram), vault: input.vault, tokenProgram: input.tokenProgram, amount: input.amount });
}

/** What `claim_invariant` refuses before it reads the cross: expired, an unknown or uncovered invariant, one that already paid. */
export function checkBountyClaim(b: Pick<Bounty, 'expiresAt' | 'rewards' | 'paidMask'>, invariant: number, now: bigint): ProgramIssue[] {
  if (!(now < b.expiresAt)) return [{ code: 'Expired', field: 'bounty', message: 'the bounty has expired' }];
  if (!Number.isInteger(invariant) || invariant < 0 || invariant >= BOUNTY_INVARIANTS) return [{ code: 'UnknownInvariant', field: 'invariant', message: `invariants are 0 to ${BOUNTY_INVARIANTS - 1}` }];
  if (!((b.rewards[invariant] ?? 0n) > 0n)) return [{ code: 'NotCovered', field: 'invariant', message: 'this bounty pays no reward for that invariant' }];
  if ((b.paidMask & (1 << invariant)) !== 0) return [{ code: 'AlreadyPaid', field: 'invariant', message: 'that invariant has already paid' }];
  return [];
}

/** `claim_invariant`: pays the reward to the claimant's token account (created first when asked) if `cross` breaks the invariant. */
export async function buildClaimInvariant(input: { claimant: TransactionSigner; bounty: Address; vault: Address; rewardMint: Address; tokenProgram: Address; cross: Address; invariant: number; createDestination?: boolean }): Promise<Instruction[]> {
  const dest = await ata(input.claimant.address, input.rewardMint, input.tokenProgram);
  const ix = getClaimInvariantInstruction({ claimant: input.claimant, bounty: input.bounty, rewardMint: input.rewardMint, cross: input.cross, vault: input.vault, claimantToken: dest, tokenProgram: input.tokenProgram, invariant: input.invariant });
  return input.createDestination ? [createAtaIdempotent(input.claimant, input.claimant.address, input.rewardMint, input.tokenProgram, dest), ix] : [ix];
}

/** `award` (the arbiter): pays `amount` to the hunter's token account for a report the chain cannot check; `evidence` is the report's hash (32 bytes). */
export async function buildAward(input: { arbiter: TransactionSigner; bounty: Address; vault: Address; rewardMint: Address; tokenProgram: Address; hunter: Address; amount: bigint; evidence: Uint8Array; createDestination?: boolean }): Promise<Instruction[]> {
  refuse([...(input.amount > 0n ? [] : [{ code: 'NothingToDo', field: 'amount', message: 'award a positive amount' }]), ...(input.evidence.length === 32 ? [] : [{ code: 'BadEvidence', field: 'evidence', message: 'the evidence is a 32-byte hash' }])]);
  const dest = await ata(input.hunter, input.rewardMint, input.tokenProgram);
  const ix = getAwardInstruction({ arbiter: input.arbiter, bounty: input.bounty, rewardMint: input.rewardMint, vault: input.vault, hunterToken: dest, tokenProgram: input.tokenProgram, amount: input.amount, evidence: input.evidence });
  return input.createDestination ? [createAtaIdempotent(input.arbiter, input.hunter, input.rewardMint, input.tokenProgram, dest), ix] : [ix];
}

/** `withdraw` (the sponsor, after the expiry). */
export async function buildWithdrawBounty(input: { sponsor: TransactionSigner; bounty: Address; vault: Address; rewardMint: Address; tokenProgram: Address; amount: bigint; expiresAt?: bigint; now?: bigint }): Promise<Instruction> {
  const issues: ProgramIssue[] = [];
  if (input.expiresAt !== undefined && (input.now ?? BigInt(Math.floor(Date.now() / 1000))) < input.expiresAt) issues.push({ code: 'StillCommitted', field: 'bounty', message: `the pool is committed until ${input.expiresAt}` });
  if (!(input.amount > 0n)) issues.push({ code: 'NothingToDo', field: 'amount', message: 'withdraw a positive amount' });
  refuse(issues);
  return getWithdrawInstruction({ sponsor: input.sponsor, bounty: input.bounty, rewardMint: input.rewardMint, vault: input.vault, sponsorToken: await ata(input.sponsor.address, input.rewardMint, input.tokenProgram), tokenProgram: input.tokenProgram, amount: input.amount });
}
