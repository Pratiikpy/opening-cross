// Unsigned-instruction builders for the treasury extension (ADR-0470 to ADR-0476) and for the first release's instructions, one per
// instruction, with the accounts derived: a caller names the treasury, its coin and quote mints (the `TreasuryContext`), the wallet that
// signs, and the arguments.
//
// Every builder returns `@solana/kit` instructions that a caller compiles and a wallet signs, like the builders of `@opening-cross/sdk`.
// The extension's instructions need the extended program (HUMAN_TASKS H27); a treasury that was never extended (`decodeTreasuryExt` is null)
// is refused by the program with `NotExtended`. `spend`, `redeem`, `trigger_liquidation`, `record_attested` and `record_lapse` exist in the
// program deployed on devnet today.
import {
  type AccountMeta,
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import { getClaimDistributionInstructionAsync } from './generated/instructions/claimDistribution.js';
import { getCreateGrantInstructionAsync, type CreateGrantInstructionDataArgs } from './generated/instructions/createGrant.js';
import { getDepositDistributionInstructionAsync } from './generated/instructions/depositDistribution.js';
import { getExecuteProposalInstructionAsync } from './generated/instructions/executeProposal.js';
import { getExpireGrantInstructionAsync } from './generated/instructions/expireGrant.js';
import { getInitExtInstructionAsync, type InitExtInstructionDataArgs } from './generated/instructions/initExt.js';
import { getMarkMissedInstructionAsync } from './generated/instructions/markMissed.js';
import { getNavRedeemInstructionAsync } from './generated/instructions/navRedeem.js';
import { getPayRoundInstructionAsync } from './generated/instructions/payRound.js';
import { getPostDisclosureInstruction } from './generated/instructions/postDisclosure.js';
import { getProposeInstructionAsync } from './generated/instructions/propose.js';
import { getReclaimVoteInstructionAsync } from './generated/instructions/reclaimVote.js';
import { getRecordAssignmentInstruction } from './generated/instructions/recordAssignment.js';
import { getRecordAttestedInstruction } from './generated/instructions/recordAttested.js';
import { getRecordLapseInstruction } from './generated/instructions/recordLapse.js';
import { getRedeemInstruction } from './generated/instructions/redeem.js';
import { getReleaseMilestoneInstructionAsync } from './generated/instructions/releaseMilestone.js';
import { getReleaseTrancheInstructionAsync } from './generated/instructions/releaseTranche.js';
import { getRequestDisclosureInstruction } from './generated/instructions/requestDisclosure.js';
import { getSpendInstruction } from './generated/instructions/spend.js';
import { getStakeInstructionAsync } from './generated/instructions/stake.js';
import { getSweepUnclaimedInstructionAsync } from './generated/instructions/sweepUnclaimed.js';
import { getTriggerLiquidationInstruction } from './generated/instructions/triggerLiquidation.js';
import { getUnstakeInstructionAsync } from './generated/instructions/unstake.js';
import { getVoteInstructionAsync } from './generated/instructions/vote.js';
import { findGrantPda, findProposalPda, findVaultPda, findVoteRecordPda, findPositionPda, findRoundRecordPda, findTreasuryPda, findCoinVaultPda, findDistVaultPda } from './generated/pdas/index.js';
import type { ProposalKind } from './generated/types/proposalKind.js';
import { getGrantMilestoneNonce, getRevenueRoundNonce } from './nonces.js';

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);

export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
/** The Solana Attestation Service (attestations the treasury reads: spend, revenue rounds, milestones, assignment). */
export const SAS_PROGRAM = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;

/** What every treasury builder needs to know about the treasury: its coin, its quote token and their token programs. */
export type TreasuryContext = {
  treasury: Address;
  coinMint: Address;
  quoteMint: Address;
  coinTokenProgram: Address;
  quoteTokenProgram: Address;
};

/** The associated token account of `owner` for `mint`. */
export async function associatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: ASSOCIATED_TOKEN_PROGRAM, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] }))[0];
}

/** Creates the associated token account if it does not exist (idempotent), paid by `payer`. */
export async function createAssociatedTokenIdempotent(payer: TransactionSigner, owner: Address, mint: Address, tokenProgram: Address): Promise<Instruction> {
  const accounts: AccountMeta[] = [
    { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer } as AccountMeta,
    { address: await associatedTokenAddress(owner, mint, tokenProgram), role: AccountRole.WRITABLE },
    { address: owner, role: AccountRole.READONLY },
    { address: mint, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: tokenProgram, role: AccountRole.READONLY },
  ];
  return { programAddress: ASSOCIATED_TOKEN_PROGRAM, accounts, data: new Uint8Array([1]) };
}

const coinOf = (c: TreasuryContext, owner: Address) => associatedTokenAddress(owner, c.coinMint, c.coinTokenProgram);
const quoteOf = (c: TreasuryContext, owner: Address) => associatedTokenAddress(owner, c.quoteMint, c.quoteTokenProgram);

// ------------------------------------------------------------------ attestations the program reads

/** The address of the SAS attestation `(credential, schema, nonce)`. */
export async function attestationAddress(credential: Address, schema: Address, nonce: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: SAS_PROGRAM, seeds: [text('attestation'), enc.encode(credential), enc.encode(schema), enc.encode(nonce)] }))[0];
}
/** The attestation of revenue round `round`: the treasury's revenue credential and schema, nonce from `getRevenueRoundNonce`. */
export async function revenueAttestationAddress(t: { treasury: Address; revCredential: Address; revSchema: Address }, round: bigint): Promise<Address> {
  return attestationAddress(t.revCredential, t.revSchema, await getRevenueRoundNonce(t.treasury, round));
}
/** The attestation of milestone `index` of `grant`, under the credential and schema the grant was created with. */
export async function milestoneAttestationAddress(g: { grant: Address; credential: Address; schema: Address }, index: number): Promise<Address> {
  return attestationAddress(g.credential, g.schema, await getGrantMilestoneNonce(g.grant, index));
}
/** The attestation the treasury's spend path (and `record_attested`, `record_lapse`) reads: nonce is the treasury address. */
export async function spendAttestationAddress(t: { treasury: Address; credential: Address; schema: Address }): Promise<Address> {
  return attestationAddress(t.credential, t.schema, t.treasury);
}
/** The attestation `record_assignment` reads: counsel's credential and schema, nonce the treasury address. */
export async function assignmentAttestationAddress(t: { treasury: Address; assignCredential: Address; assignSchema: Address }): Promise<Address> {
  return attestationAddress(t.assignCredential, t.assignSchema, t.treasury);
}

// ------------------------------------------------------------------ the extension

/** Extends a treasury once: holder votes, the NAV window, distributions, revenue rounds, disclosure, the assignment gate, the wind-down. */
export async function buildInitExt(c: TreasuryContext, authority: TransactionSigner, params: InitExtInstructionDataArgs): Promise<Instruction> {
  return getInitExtInstructionAsync({ authority, treasury: c.treasury, coinMint: c.coinMint, quoteMint: c.quoteMint, coinTokenProgram: c.coinTokenProgram, quoteTokenProgram: c.quoteTokenProgram, ...params });
}

// ------------------------------------------------------------------ holder votes (ADR-0471)

export type ProposalInput = { id: bigint; kind: ProposalKind; amount: bigint; destination: Address; descHash: Uint8Array };
export async function buildPropose(c: TreasuryContext, proposer: TransactionSigner, p: ProposalInput): Promise<Instruction> {
  return getProposeInstructionAsync({ proposer, treasury: c.treasury, coinMint: c.coinMint, proposerCoin: await coinOf(c, proposer.address), id: p.id, kind: p.kind, amount: p.amount, destination: p.destination, descHash: p.descHash });
}
export async function buildVote(c: TreasuryContext, voter: TransactionSigner, id: bigint, support: boolean, amount: bigint): Promise<Instruction> {
  const [proposal] = await findProposalPda({ treasury: c.treasury, id });
  return getVoteInstructionAsync({ voter, treasury: c.treasury, proposal, coinMint: c.coinMint, voterCoin: await coinOf(c, voter.address), coinTokenProgram: c.coinTokenProgram, support, amount });
}
/** Gives the voter's locked coins back once the vote is over. */
export async function buildReclaimVote(c: TreasuryContext, voter: TransactionSigner, id: bigint): Promise<Instruction> {
  const [proposal] = await findProposalPda({ treasury: c.treasury, id });
  const [voteRecord] = await findVoteRecordPda({ proposal, voter: voter.address });
  return getReclaimVoteInstructionAsync({ voter, treasury: c.treasury, proposal, voteRecord, coinMint: c.coinMint, voterCoin: await coinOf(c, voter.address), coinTokenProgram: c.coinTokenProgram });
}
/** Executes a passed proposal. `destination` is a quote token account and must be the one named when the proposal was made. */
export async function buildExecuteProposal(c: TreasuryContext, executor: TransactionSigner, id: bigint, destination: Address): Promise<Instruction> {
  const [proposal] = await findProposalPda({ treasury: c.treasury, id });
  return getExecuteProposalInstructionAsync({ executor, treasury: c.treasury, proposal, coinMint: c.coinMint, quoteMint: c.quoteMint, destination, quoteTokenProgram: c.quoteTokenProgram });
}
/** Burns `amount` coins for their share of the vault at NAV, while a NAV window is open. Creates the holder's quote account if missing. */
export async function buildNavRedeem(c: TreasuryContext, holder: TransactionSigner, amount: bigint): Promise<Instruction[]> {
  return [
    await createAssociatedTokenIdempotent(holder, holder.address, c.quoteMint, c.quoteTokenProgram),
    await getNavRedeemInstructionAsync({ holder, treasury: c.treasury, coinMint: c.coinMint, quoteMint: c.quoteMint, holderCoin: await coinOf(c, holder.address), holderQuote: await quoteOf(c, holder.address), coinTokenProgram: c.coinTokenProgram, quoteTokenProgram: c.quoteTokenProgram, amount }),
  ];
}

// ------------------------------------------------------------------ distributions (ADR-0472)

export async function buildStake(c: TreasuryContext, owner: TransactionSigner, amount: bigint): Promise<Instruction> {
  return getStakeInstructionAsync({ owner, treasury: c.treasury, coinMint: c.coinMint, ownerCoin: await coinOf(c, owner.address), coinTokenProgram: c.coinTokenProgram, amount });
}
export async function buildUnstake(c: TreasuryContext, owner: TransactionSigner, amount: bigint): Promise<Instruction> {
  return getUnstakeInstructionAsync({ owner, treasury: c.treasury, coinMint: c.coinMint, ownerCoin: await coinOf(c, owner.address), coinTokenProgram: c.coinTokenProgram, amount });
}
/** Anyone deposits quote tokens for the stakers (streamed over `stream_secs` when the treasury streams). */
export async function buildDepositDistribution(c: TreasuryContext, depositor: TransactionSigner, amount: bigint): Promise<Instruction> {
  return getDepositDistributionInstructionAsync({ depositor, treasury: c.treasury, quoteMint: c.quoteMint, depositorQuote: await quoteOf(c, depositor.address), quoteTokenProgram: c.quoteTokenProgram, amount });
}
/** Pays a staker what they have earned. Creates the staker's quote account if missing. */
export async function buildClaimDistribution(c: TreasuryContext, owner: TransactionSigner): Promise<Instruction[]> {
  return [
    await createAssociatedTokenIdempotent(owner, owner.address, c.quoteMint, c.quoteTokenProgram),
    await getClaimDistributionInstructionAsync({ owner, treasury: c.treasury, quoteMint: c.quoteMint, ownerQuote: await quoteOf(c, owner.address), quoteTokenProgram: c.quoteTokenProgram }),
  ];
}

// ------------------------------------------------------------------ verified revenue (ADR-0472)

/** Pays the stakers' share of round `round`'s attested revenue. `attestation` defaults to the one derived from the treasury's revenue credential and schema (`revenueAttestationAddress`). */
export async function buildPayRound(c: TreasuryContext, payer: TransactionSigner, round: bigint, attestation: Address): Promise<Instruction> {
  return getPayRoundInstructionAsync({ payer, treasury: c.treasury, quoteMint: c.quoteMint, payerQuote: await quoteOf(c, payer.address), attestation, quoteTokenProgram: c.quoteTokenProgram, round });
}
/** Marks a round nobody paid within the grace period as missed: the NAV window opens. Anyone may send it. */
export async function buildMarkMissed(c: TreasuryContext, caller: TransactionSigner, round: bigint): Promise<Instruction> {
  return getMarkMissedInstructionAsync({ caller, treasury: c.treasury, coinMint: c.coinMint, round });
}
/** Releases the team's tranche for a paid round whose revenue met the bar. */
export async function buildReleaseTranche(c: TreasuryContext, authority: TransactionSigner, round: bigint, destination: Address): Promise<Instruction> {
  return getReleaseTrancheInstructionAsync({ authority, treasury: c.treasury, quoteMint: c.quoteMint, destination, quoteTokenProgram: c.quoteTokenProgram, round });
}

// ------------------------------------------------------------------ team grants (ADR-0473)

export type GrantInput = {
  id: bigint;
  beneficiary: Address;
  total: bigint;
  lockupEnd: bigint;
  expiryTs: bigint;
  /** One to four milestones, in basis points of the grant; `requiresAttestation` milestones are released by a SAS attestation. */
  milestones: { bps: number; requiresAttestation: boolean }[];
  credential: Address;
  schema: Address;
};
export async function buildCreateGrant(c: TreasuryContext, authority: TransactionSigner, g: GrantInput): Promise<Instruction> {
  if (g.milestones.length < 1 || g.milestones.length > 4) throw new Error('a grant has one to four milestones');
  const milestones = g.milestones.map((m) => ({ ...m, released: false }));
  while (milestones.length < 4) milestones.push({ bps: 0, requiresAttestation: false, released: false });
  const args: Omit<CreateGrantInstructionDataArgs, 'discriminator'> = { id: g.id, beneficiary: g.beneficiary, total: g.total, lockupEnd: g.lockupEnd, expiryTs: g.expiryTs, milestones, milestoneCount: g.milestones.length, credential: g.credential, schema: g.schema };
  return getCreateGrantInstructionAsync({ authority, treasury: c.treasury, coinMint: c.coinMint, authorityCoin: await coinOf(c, authority.address), coinTokenProgram: c.coinTokenProgram, ...args } as never);
}
/** Releases a milestone's coins to the beneficiary (created token account if missing). `attestation` is the milestone's attestation, or omitted for a milestone that needs none. Anyone may send it. */
export async function buildReleaseMilestone(c: TreasuryContext, cranker: TransactionSigner, grantId: bigint, index: number, beneficiary: Address, attestation?: Address): Promise<Instruction[]> {
  const [grant] = await findGrantPda({ treasury: c.treasury, id: grantId });
  return [
    await createAssociatedTokenIdempotent(cranker, beneficiary, c.coinMint, c.coinTokenProgram),
    await getReleaseMilestoneInstructionAsync({ cranker, treasury: c.treasury, grant, coinMint: c.coinMint, beneficiaryCoin: await coinOf(c, beneficiary), attestation: attestation ?? SYSTEM_PROGRAM, coinTokenProgram: c.coinTokenProgram, index }),
  ];
}
/** Burns a grant's unearned coins once it has expired. Anyone may send it. */
export async function buildExpireGrant(c: TreasuryContext, cranker: TransactionSigner, grantId: bigint): Promise<Instruction> {
  const [grant] = await findGrantPda({ treasury: c.treasury, id: grantId });
  return getExpireGrantInstructionAsync({ cranker, treasury: c.treasury, grant, coinMint: c.coinMint, coinTokenProgram: c.coinTokenProgram });
}

// ------------------------------------------------------------------ disclosure, assignment, wind-down (ADR-0474, ADR-0475)

export function buildPostDisclosure(c: TreasuryContext, authority: TransactionSigner, hash: Uint8Array): Instruction {
  return getPostDisclosureInstruction({ authority, treasury: c.treasury, hash });
}
export async function buildRequestDisclosure(c: TreasuryContext, holder: TransactionSigner): Promise<Instruction> {
  return getRequestDisclosureInstruction({ holder, treasury: c.treasury, coinMint: c.coinMint, holderCoin: await coinOf(c, holder.address) });
}
/** Records counsel's assignment attestation so the team's spending gate opens. Anyone may send it. */
export function buildRecordAssignment(c: TreasuryContext, attestation: Address): Instruction {
  return getRecordAssignmentInstruction({ treasury: c.treasury, attestation });
}
/** After the wind-down window, moves what holders did not redeem to the recovery account fixed in advance. Anyone may send it. */
export async function buildSweepUnclaimed(c: TreasuryContext, recoveryQuote: Address): Promise<Instruction> {
  return getSweepUnclaimedInstructionAsync({ treasury: c.treasury, quoteMint: c.quoteMint, recoveryQuote, quoteTokenProgram: c.quoteTokenProgram });
}

// ------------------------------------------------------------------ the first release's instructions (deployed on devnet)

/** The team spends within its allowance, to a quote token account, while the attestation is live. */
export async function buildSpend(c: TreasuryContext, authority: TransactionSigner, amount: bigint, attestation: Address, destination: Address): Promise<Instruction> {
  const [vault] = await findVaultPda({ treasury: c.treasury });
  return getSpendInstruction({ authority, treasury: c.treasury, attestation, quoteMint: c.quoteMint, vault, destination, quoteTokenProgram: c.quoteTokenProgram, amount });
}
export function buildRecordAttested(c: TreasuryContext, attestation: Address): Instruction {
  return getRecordAttestedInstruction({ treasury: c.treasury, attestation });
}
export function buildRecordLapse(c: TreasuryContext, attestation: Address): Instruction {
  return getRecordLapseInstruction({ treasury: c.treasury, attestation });
}
/** Starts the liquidation after the grace period: snapshots the vault and the supply. Anyone may send it. */
export async function buildTriggerLiquidation(c: TreasuryContext): Promise<Instruction> {
  const [vault] = await findVaultPda({ treasury: c.treasury });
  return getTriggerLiquidationInstruction({ treasury: c.treasury, coinMint: c.coinMint, vault });
}
/** Burns `amount` coins for their pro-rata share of the liquidation snapshot. Creates the holder's quote account if missing. */
export async function buildRedeem(c: TreasuryContext, holder: TransactionSigner, amount: bigint): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ treasury: c.treasury });
  return [
    await createAssociatedTokenIdempotent(holder, holder.address, c.quoteMint, c.quoteTokenProgram),
    getRedeemInstruction({ holder, treasury: c.treasury, coinMint: c.coinMint, quoteMint: c.quoteMint, holderCoin: await coinOf(c, holder.address), holderQuote: await quoteOf(c, holder.address), vault, coinTokenProgram: c.coinTokenProgram, quoteTokenProgram: c.quoteTokenProgram, amount }),
  ];
}

// ------------------------------------------------------------------ addresses a reader needs

export async function treasuryAccounts(coinMint: Address) {
  const [treasury] = await findTreasuryPda({ coinMint });
  const [vault] = await findVaultPda({ treasury });
  const [coinVault] = await findCoinVaultPda({ treasury });
  const [distVault] = await findDistVaultPda({ treasury });
  return { treasury, vault, coinVault, distVault };
}
export async function positionAddress(treasury: Address, owner: Address): Promise<Address> {
  return (await findPositionPda({ treasury, owner }))[0];
}
export async function proposalAddress(treasury: Address, id: bigint): Promise<Address> {
  return (await findProposalPda({ treasury, id }))[0];
}
export async function voteRecordAddress(treasury: Address, id: bigint, voter: Address): Promise<Address> {
  return (await findVoteRecordPda({ proposal: await proposalAddress(treasury, id), voter }))[0];
}
export async function grantAddress(treasury: Address, id: bigint): Promise<Address> {
  return (await findGrantPda({ treasury, id }))[0];
}
export async function roundRecordAddress(treasury: Address, round: bigint): Promise<Address> {
  return (await findRoundRecordPda({ treasury, round }))[0];
}
