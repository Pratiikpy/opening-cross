// Builders for `cross_graduate` (D10, Z0; ADR-0656): graduation by holder vote. A cross whose creator set `FLAG_GOVERNED_GRADUATION` opens a pool only on
// the venue holders chose: a charter fixes the terms, rounds lock votes behind a venue, `finalize_round` decides, `publish_outcome` writes what `cross_settle` reads.
import { type Address, type Instruction, type ReadonlyUint8Array, type TransactionSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  type Charter,
  CROSS_GRADUATE_PROGRAM_ADDRESS,
  type Outcome,
  type Round,
  type VoteRecord,
  findCharterPda,
  findVotePda,
  getCastVoteInstruction,
  getFinalizeRoundInstruction,
  getInitCharterInstruction,
  getPostVolumeInstruction,
  getPublishOutcomeInstruction,
  getStartRoundInstruction,
  getWithdrawVoteInstruction,
} from '@opening-cross/cross-graduate-client';
import { type Cross, CrossState, FLAG_GOVERNED_GRADUATION, type CrossExt, ata, readonly } from '../index.js';
import { type ProgramIssue, refuse } from './common.js';

export { CROSS_GRADUATE_PROGRAM_ADDRESS };
export type { Charter, Outcome, Round, VoteRecord };

/** The venues a round chooses between, in the order of `cross_settle`'s adapters. */
export const GRADUATE_VENUES = ['damm_v2', 'dlmm', 'raydium_cpmm', 'metadao_futarchy'] as const;
export type GraduateVenue = (typeof GRADUATE_VENUES)[number];
export const GRADUATE_VENUE_COUNT = GRADUATE_VENUES.length;
/** The voting window is three to thirty days; the quorum from 10% to 100% of the live supply; at most three rounds (the program's constants). */
export const GRADUATE_MIN_WINDOW_SECS = 3n * 86_400n;
export const GRADUATE_MAX_WINDOW_SECS = 30n * 86_400n;
export const GRADUATE_MIN_QUORUM_BPS = 1_000;
export const GRADUATE_MAX_ROUNDS = 3;

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const pda = async (seeds: ReadonlyUint8Array[]) => (await getProgramDerivedAddress({ programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, seeds }))[0];

export const charterAddress = async (cross: Address): Promise<Address> => (await findCharterPda({ cross }))[0];
export const roundAddress = (cross: Address, index: number): Promise<Address> => pda([text('round'), enc.encode(cross), new Uint8Array([index])]);
export const outcomeAddress = (cross: Address): Promise<Address> => pda([text('outcome'), enc.encode(cross)]);
export const voteAddress = async (round: Address, voter: Address): Promise<Address> => (await findVotePda({ round, voter }))[0];

/** The venue number of a name, or null. */
export const venueNumber = (v: string): number | null => {
  const i = (GRADUATE_VENUES as readonly string[]).indexOf(v);
  return i < 0 ? null : i;
};

/** Whether a cross's rules carry `FLAG_GOVERNED_GRADUATION`. */
export const isGoverned = (ext: CrossExt | null | undefined): boolean => !!ext && (ext.flags & FLAG_GOVERNED_GRADUATION) !== 0;

/**
 * The verdict on a round, as the program decides it (`decide`): the winning venue or null. Quorum of the live supply first, then a strict majority of what
 * was locked (a tie has no winner; among equal tallies the lowest venue number is considered), then the attested volume when the charter asks for one.
 */
export function decideRound(f: { lockedTotal: bigint; supply: bigint; quorumBps: number; tallies: readonly bigint[]; minVolume: bigint; volume: bigint | null }): number | null {
  if (f.lockedTotal === 0n) return null;
  if (f.lockedTotal * 10_000n < f.supply * BigInt(f.quorumBps)) return null;
  let winner = 0;
  let best = f.tallies[0] ?? 0n;
  f.tallies.forEach((t, i) => {
    if (t > best) {
      best = t;
      winner = i;
    }
  });
  if (best * 2n <= f.lockedTotal) return null;
  if (f.minVolume > 0n && (f.volume === null || f.volume < f.minVolume)) return null;
  return winner;
}

/** Why a round would not pass right now, for a person: the first condition that fails, in the program's order. */
export function roundShortfall(f: { lockedTotal: bigint; supply: bigint; quorumBps: number; tallies: readonly bigint[]; minVolume: bigint; volume: bigint | null }): { code: 'NO_VOTES' | 'BELOW_QUORUM' | 'NO_MAJORITY' | 'VOLUME_SHORT'; message: string } | null {
  if (f.lockedTotal === 0n) return { code: 'NO_VOTES', message: 'no tokens are locked behind any venue yet' };
  if (f.lockedTotal * 10_000n < f.supply * BigInt(f.quorumBps)) return { code: 'BELOW_QUORUM', message: `locked tokens are below the quorum of ${f.quorumBps / 100}% of the live supply` };
  const best = f.tallies.reduce((m, t) => (t > m ? t : m), 0n);
  if (best * 2n <= f.lockedTotal) return { code: 'NO_MAJORITY', message: 'no venue holds a strict majority of the locked tokens' };
  if (f.minVolume > 0n && (f.volume === null || f.volume < f.minVolume)) return { code: 'VOLUME_SHORT', message: 'the attested organic volume is missing or below the charter minimum' };
  return null;
}

/** What `init_charter` refuses from the terms. */
export function checkCharterTerms(t: { quorumBps: number; windowSecs: bigint; minVolume: bigint; volumeAttester: Address | null }): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (!Number.isInteger(t.quorumBps) || t.quorumBps < GRADUATE_MIN_QUORUM_BPS || t.quorumBps > 10_000) out.push({ code: 'BadCharter', field: 'quorumBps', message: 'the quorum is between 1,000 and 10,000 basis points (10% to 100% of the live supply)' });
  if (t.windowSecs < GRADUATE_MIN_WINDOW_SECS || t.windowSecs > GRADUATE_MAX_WINDOW_SECS) out.push({ code: 'BadCharter', field: 'windowSecs', message: 'the voting window is between 3 and 30 days' });
  if (t.minVolume > 0n && t.volumeAttester === null) out.push({ code: 'BadCharter', field: 'volumeAttester', message: 'a minimum organic volume needs the key that attests it' });
  return out;
}

/** What `init_charter` reads from the cross: the creator signs, the cross takes no order yet, and it carries the governed-graduation rule. */
export function checkCharterCross(f: { creator: Address; cross: { data: Pick<Cross, 'creator' | 'state' | 'ordersTotal'>; ext?: CrossExt | null } }): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (f.cross.data.creator !== f.creator) out.push({ code: 'NotTheCreator', field: 'creator', message: 'only the wallet that created the cross can set its charter' });
  if (f.cross.data.state !== CrossState.Live || f.cross.data.ordersTotal !== 0) out.push({ code: 'TooLate', field: 'cross', message: 'the charter is set before the first order' });
  if (!isGoverned(f.cross.ext)) out.push({ code: 'NotGoverned', field: 'cross', message: 'this cross did not set the governed-graduation rule (flag 32) when it was created' });
  return out;
}

/** `init_charter`: the terms never change. */
export async function buildInitCharter(input: { creator: TransactionSigner; cross: Address; quorumBps: number; windowSecs: bigint; minVolume: bigint; volumeAttester: Address | null }): Promise<{ instruction: Instruction; charter: Address }> {
  refuse(checkCharterTerms(input));
  const charter = await charterAddress(input.cross);
  return { charter, instruction: getInitCharterInstruction({ creator: input.creator, cross: input.cross, charter, quorumBps: input.quorumBps, windowSecs: input.windowSecs, minVolume: input.minVolume, volumeAttester: input.volumeAttester }) };
}

/** `start_round`: the creator opens the next round once the cross is finalized and its token exists. */
export async function buildStartRound(input: { creator: TransactionSigner; cross: Address; baseMint: Address; baseTokenProgram: Address; index: number }): Promise<{ instruction: Instruction; round: Address; escrow: Address }> {
  const charter = await charterAddress(input.cross);
  const round = await roundAddress(input.cross, input.index);
  const escrow = await ata(round, input.baseMint, input.baseTokenProgram);
  return { round, escrow, instruction: getStartRoundInstruction({ creator: input.creator, cross: input.cross, charter, baseMint: input.baseMint, round, escrow, tokenProgram: input.baseTokenProgram }) };
}

/** What `cast_vote` refuses from the round and the vote so far. */
export function checkVote(f: { round: Pick<Round, 'finalized' | 'opensTs' | 'closesTs'>; venue: number; amount: bigint; now: bigint; existingVenue?: number | null }): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (f.round.finalized || f.now < f.round.opensTs || f.now >= f.round.closesTs) out.push({ code: 'NotVoting', field: 'round', message: 'the voting window is not open' });
  if (!Number.isInteger(f.venue) || f.venue < 0 || f.venue >= GRADUATE_VENUE_COUNT) out.push({ code: 'UnknownVenue', field: 'venue', message: `venues are 0 to ${GRADUATE_VENUE_COUNT - 1}: ${GRADUATE_VENUES.join(', ')}` });
  if (!(f.amount > 0n)) out.push({ code: 'NothingToDo', field: 'amount', message: 'lock a positive amount' });
  if (f.existingVenue !== undefined && f.existingVenue !== null && f.existingVenue !== f.venue) out.push({ code: 'VenueLocked', field: 'venue', message: `this wallet already locked tokens behind venue ${f.existingVenue}; a stake can grow but not change venue` });
  return out;
}

/** `cast_vote`: locks tokens in the round's escrow until the window ends. */
export async function buildCastVote(input: { voter: TransactionSigner; round: Address; baseMint: Address; baseTokenProgram: Address; venue: number; amount: bigint }): Promise<Instruction> {
  const vote = await voteAddress(input.round, input.voter.address);
  return getCastVoteInstruction({ voter: input.voter, round: input.round, baseMint: input.baseMint, voterToken: await ata(input.voter.address, input.baseMint, input.baseTokenProgram), escrow: await ata(input.round, input.baseMint, input.baseTokenProgram), vote, tokenProgram: input.baseTokenProgram, venue: input.venue, amount: input.amount });
}

/** `post_volume` (the charter's attester): the organic volume in quote atoms, as of now. The latest statement counts. */
export function buildPostVolume(input: { attester: TransactionSigner; round: Address; volumeQuote: bigint }): Instruction {
  return getPostVolumeInstruction({ attester: input.attester, round: input.round, volumeQuote: input.volumeQuote });
}

/** `finalize_round` (anyone, after the window). */
export async function buildFinalizeRound(input: { cross: Address; round: Address; baseMint: Address }): Promise<Instruction> {
  return getFinalizeRoundInstruction({ round: input.round, charter: await charterAddress(input.cross), baseMint: input.baseMint });
}

/** `publish_outcome` (anyone, once a round passed): writes the account `cross_settle` reads. */
export async function buildPublishOutcome(input: { payer: TransactionSigner; cross: Address; round: Address }): Promise<{ instruction: Instruction; outcome: Address }> {
  const outcome = await outcomeAddress(input.cross);
  return { outcome, instruction: getPublishOutcomeInstruction({ payer: input.payer, round: input.round, outcome }) };
}

/** `withdraw_vote` (the voter, after the window): the locked tokens back. */
export async function buildWithdrawVote(input: { voter: TransactionSigner; round: Address; baseMint: Address; baseTokenProgram: Address }): Promise<Instruction> {
  const vote = await voteAddress(input.round, input.voter.address);
  return getWithdrawVoteInstruction({ voter: input.voter, round: input.round, baseMint: input.baseMint, vote, escrow: await ata(input.round, input.baseMint, input.baseTokenProgram), voterToken: await ata(input.voter.address, input.baseMint, input.baseTokenProgram), tokenProgram: input.baseTokenProgram });
}

/**
 * The account a seeding instruction of a governed cross takes as its last remaining account: the `Outcome` PDA, read-only. `buildSeedDammV2`,
 * `buildOpenDlmmPair` and `buildSeedRaydiumCpmm` of `@opening-cross/adapters` take it as `outcome`; for `open_dlmm_pair_badged` it follows the two badge accounts.
 */
export async function governedOutcomeAccount(cross: Address) {
  return readonly(await outcomeAddress(cross));
}
