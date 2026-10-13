// Shared support for the transaction routes whose instruction may not exist on the connected cluster yet (docs/HUMAN_TASKS.md H27):
// the release check, the compute-budget instruction, and a compile that refuses a transaction the network would drop for its size.
//
// The release check reads the program's own bytes, the way GET /v1/programs does (holder-programs.ts, ADR-0600): an Anchor program loads each
// instruction's 8-byte discriminator with one `lddw`, so the instruction is in the ProgramData account or it is not. Three answers:
//   present  the instruction is in the deployed program
//   absent   the program was read, a control instruction every release has was found, and this instruction is not there: the route refuses (409
//            PROGRAM_NOT_DEPLOYED) instead of handing out a transaction the program would refuse with InstructionFallbackNotFound
//   unknown  the program could not be read, or the control instruction was not found so the scan is not trusted: the route builds the transaction and
//            says the release was not checked. An unreadable program is never reported as an old one.
import { type Address, type Instruction, getAddressDecoder } from '@solana/kit';
import { TRANSACTION_LIMIT_BYTES, wireSize } from '@opening-cross/sdk';
import { type Lifetime, RequestError, type UnsignedTx, compile } from '../tx.js';
import { loadsDiscriminator } from './holder-programs.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type Presence = 'present' | 'absent' | 'unknown';
export type ReleaseGate = (program: Address, instruction: { name: string; discriminator: Uint8Array }, control: Uint8Array) => Promise<Presence>;

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const HEADER = 45; // u32 tag, u64 slot, u8 option, 32-byte upgrade authority

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * A release check over `account`. A definite answer is kept for `ttlMs` (default ten minutes: a program changes only when it is upgraded); an unknown
 * one is asked again at once. The ProgramData account is read once per call that has to scan, not once per instruction.
 */
export function releaseGate(d: { account: (a: Address) => Promise<ChainAccount | null>; clock?: () => number; ttlMs?: number }): ReleaseGate {
  const now = () => (d.clock ? d.clock() * 1000 : Date.now());
  const ttl = d.ttlMs ?? 600_000;
  const kept = new Map<string, { at: number; presence: Presence }>();
  return async (program, instruction, control) => {
    const key = `${program}:${hex(instruction.discriminator)}`;
    const hit = kept.get(key);
    if (hit && now() - hit.at < ttl) return hit.presence;
    const presence = await scan(d.account, program, instruction.discriminator, control);
    if (presence !== 'unknown') kept.set(key, { at: now(), presence });
    return presence;
  };
}

async function scan(account: (a: Address) => Promise<ChainAccount | null>, program: Address, disc: Uint8Array, control: Uint8Array): Promise<Presence> {
  try {
    const p = await account(program);
    if (!p || p.owner !== LOADER || p.data.length < 36) return 'unknown';
    const data = await account(getAddressDecoder().decode(p.data.subarray(4, 36)));
    if (!data || data.data.length < HEADER + 64) return 'unknown';
    const elf = data.data.subarray(HEADER);
    if (!loadsDiscriminator(elf, control)) return 'unknown';
    return loadsDiscriminator(elf, disc) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/**
 * Refuses (409 PROGRAM_NOT_DEPLOYED) when the deployed program definitely lacks the instruction. Returns what the response should say about the release:
 * `deployed: true` when it was found, `null` when it could not be checked.
 */
export async function requireInstruction(gate: ReleaseGate | undefined, program: Address, instruction: { name: string; discriminator: Uint8Array }, control: Uint8Array): Promise<{ program: Address; instruction: string; deployed: true | null }> {
  const presence = gate ? await gate(program, instruction, control) : 'unknown';
  if (presence === 'absent') {
    throw new RequestError(409, `The program ${program} deployed on this cluster does not have the instruction ${instruction.name} yet: it is built and proved locally and is not deployed until the operations key is funded (docs/HUMAN_TASKS.md H27). GET /v1/programs reports the release.`, {
      reason: 'PROGRAM_NOT_DEPLOYED',
      program,
      instruction: instruction.name,
    });
  }
  return { program, instruction: instruction.name, deployed: presence === 'present' ? true : null };
}

/** An external program the route builds for (Meteora's DAMM v2, DLMM, Alpha Vault, Met Lock, Dynamic Fee Sharing) must exist on this cluster. */
export async function requireProgram(account: (a: Address) => Promise<ChainAccount | null>, program: Address, name: string): Promise<void> {
  let acct: ChainAccount | null;
  try {
    acct = await account(program);
  } catch {
    return; // an unreadable cluster is the RPC's problem; the program decides
  }
  if (!acct) throw new RequestError(409, `${name} (${program}) is not deployed on this cluster, so a transaction for it would fail.`, { reason: 'EXTERNAL_PROGRAM_MISSING', program, name });
}

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111' as Address;
/** `SetComputeUnitLimit`: the heavy settlement instructions call into Meteora's programs and need more than the default 200,000 units. */
export function computeUnits(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}
/** The limit the program test suites run these instructions with (tests/core). */
export const HEAVY_UNITS = 1_400_000;

/** The wire size of the instructions as one transaction, or a 422 TX_TOO_LARGE naming the size. */
export function fits(feePayer: Address, ixs: Instruction[], what: string): number {
  const bytes = wireSize(feePayer, ixs);
  if (bytes > TRANSACTION_LIMIT_BYTES) throw new RequestError(422, `The ${what} is ${bytes} bytes; a transaction holds at most ${TRANSACTION_LIMIT_BYTES}.`, { reason: 'TX_TOO_LARGE', bytes, limit: TRANSACTION_LIMIT_BYTES });
  return bytes;
}

/** `compile` for one transaction, after the size check. */
export function compileFitting(feePayer: Address, ixs: Instruction[], lifetime: Lifetime, what: string): UnsignedTx & { bytes: number } {
  const bytes = fits(feePayer, ixs, what);
  return { ...compile(feePayer, ixs, lifetime), bytes };
}
