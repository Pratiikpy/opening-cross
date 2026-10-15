// Builders for `cross_backing` (F6; ADR-0655): an opted-in asset is halted on chain, on anyone's call, when its attested backing is missing, stale or below
// the issuer's committed coverage of the live supply. The watchdog PDA `["watchdog", mint]` is the asset's venue signer in `cross_core`'s halt state.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  type Attestation,
  CROSS_BACKING_PROGRAM_ADDRESS,
  type Policy,
  findAttestationPda,
  findPolicyPda,
  findWatchdogPda,
  getAttestInstruction,
  getCheckInstruction,
  getCreatePolicyInstruction,
} from '@opening-cross/cross-backing-client';
import { buildInitHaltState, haltStateAddress } from '../index.js';
import { type ProgramIssue, refuse } from './common.js';

export { CROSS_BACKING_PROGRAM_ADDRESS };
export type { Attestation, Policy };

/** An attestation is fresh for between a minute and thirty days; coverage is between 1% and 200% of the live supply (the program's constants). */
export const BACKING_MIN_AGE_SECS = 60n;
export const BACKING_MAX_AGE_SECS = 30n * 86_400n;
export const BACKING_MIN_COVERAGE_BPS = 100;
export const BACKING_MAX_COVERAGE_BPS = 20_000;

/** The verdict numbers of the `BackingFailed` event's `reason`. */
export const BackingVerdict = { Backed: 0, Missing: 1, Stale: 2, Short: 3 } as const;
export type BackingVerdictName = keyof typeof BackingVerdict;

/**
 * The verdict on one attestation, as the program decides it: stale first (an old figure, or one dated in the future, says nothing about now), then the
 * coverage of the live supply (`backing x 10,000 >= supply x minCoverageBps`). Null attestation is `Missing`.
 */
export function backingVerdict(f: { attestation: Pick<Attestation, 'backingAtoms' | 'postedTs'> | null; supply: bigint; now: bigint; minCoverageBps: number; maxAgeSecs: bigint }): BackingVerdictName {
  if (!f.attestation) return 'Missing';
  const age = f.now - f.attestation.postedTs;
  if (age < 0n || age > f.maxAgeSecs) return 'Stale';
  if (f.attestation.backingAtoms * 10_000n < f.supply * BigInt(f.minCoverageBps)) return 'Short';
  return 'Backed';
}

/** The backing that covers `supply` at `minCoverageBps`: what an attester must state at least, to keep the asset live. */
export const backingRequired = (supply: bigint, minCoverageBps: number): bigint => (supply * BigInt(minCoverageBps) + 9_999n) / 10_000n;

export function checkBackingPolicy(minCoverageBps: number, maxAgeSecs: bigint): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (!Number.isInteger(minCoverageBps) || minCoverageBps < BACKING_MIN_COVERAGE_BPS || minCoverageBps > BACKING_MAX_COVERAGE_BPS) out.push({ code: 'BadPolicy', field: 'minCoverageBps', message: 'coverage is between 100 and 20,000 basis points (1% to 200% of the live supply)' });
  if (maxAgeSecs < BACKING_MIN_AGE_SECS || maxAgeSecs > BACKING_MAX_AGE_SECS) out.push({ code: 'BadPolicy', field: 'maxAgeSecs', message: 'a statement may be fresh for between 60 seconds and 30 days' });
  return out;
}

export type BackingAddresses = { policy: Address; attestation: Address; watchdog: Address; halt: Address };
export async function backingAddresses(mint: Address): Promise<BackingAddresses> {
  return {
    policy: (await findPolicyPda({ mint }))[0],
    attestation: (await findAttestationPda({ mint }))[0],
    watchdog: (await findWatchdogPda({ mint }))[0],
    halt: await haltStateAddress(mint),
  };
}

/** The watchdog PDA of a mint: the venue signer its halt state must name for a policy to be accepted. */
export async function watchdogAddress(mint: Address): Promise<Address> {
  return (await findWatchdogPda({ mint }))[0];
}

/** `init_halt_state` naming the watchdog as the venue signer (it is fixed at creation; an existing halt state with another venue signer cannot use the watchdog). */
export async function buildInitHaltStateWithWatchdog(input: { authority: TransactionSigner; baseMint: Address }): Promise<{ halt: Address; watchdog: Address; instruction: Instruction }> {
  const watchdog = await watchdogAddress(input.baseMint);
  const built = await buildInitHaltState({ authority: input.authority, baseMint: input.baseMint, venueSigner: watchdog });
  return { ...built, watchdog };
}

/** `create_policy`: the halt state's authority opts the asset in. The terms are fixed for good. */
export async function buildCreateBackingPolicy(input: { authority: TransactionSigner; mint: Address; attester: Address; minCoverageBps: number; maxAgeSecs: bigint }): Promise<{ instruction: Instruction } & BackingAddresses> {
  refuse(checkBackingPolicy(input.minCoverageBps, input.maxAgeSecs));
  const a = await backingAddresses(input.mint);
  const instruction = getCreatePolicyInstruction({ authority: input.authority, mint: input.mint, halt: a.halt, watchdog: a.watchdog, policy: a.policy, attester: input.attester, minCoverageBps: input.minCoverageBps, maxAgeSecs: input.maxAgeSecs });
  return { instruction, ...a };
}

/** `attest` (the policy's attester): the backing in the mint's own atoms, as of now (the time is the chain's). */
export async function buildAttestBacking(input: { attester: TransactionSigner; mint: Address; backingAtoms: bigint }): Promise<Instruction> {
  const a = await backingAddresses(input.mint);
  return getAttestInstruction({ attester: input.attester, policy: a.policy, attestation: a.attestation, backingAtoms: input.backingAtoms });
}

/** `check` (anyone): halts the asset if its backing cannot be verified right now. The program refuses with `Backed` when it can, so a call that changes nothing says so. */
export async function buildCheckBacking(input: { mint: Address }): Promise<Instruction> {
  const a = await backingAddresses(input.mint);
  return getCheckInstruction({ policy: a.policy, mint: input.mint, attestation: a.attestation, watchdog: a.watchdog, halt: a.halt });
}
