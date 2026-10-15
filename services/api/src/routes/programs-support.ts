// Shared support for the routes of the seven Wave 3D programs (cross_mandate, cross_conviction, cross_basket, cross_listing, cross_bounty, cross_backing,
// cross_graduate; ADR-0650 to ADR-0656): the release check, typed account reads, token-program lookups and the one-transaction compile.
//
// These programs are proved on LiteSVM and on a local validator and are NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md
// H27, H43). A route must therefore tell three things apart, and never hand out a transaction the cluster would refuse:
//   ready              the program exists on the cluster and its bytes load the instruction
//   program-missing    the program account was read and there is none at that address: every route of the program answers 409 PROGRAM_NOT_DEPLOYED
//   instruction-missing  the program exists, a control instruction every release has was found, and this instruction was not: 409 PROGRAM_NOT_DEPLOYED
//   unknown            the cluster could not be read, or the scan could not find the control instruction so it is not trusted: the transaction is built and the
//                      answer says the release was not checked (`release.deployed: null`). An unreadable program is never reported as a missing one.
import { type Address, type Instruction, getAddressDecoder } from '@solana/kit';
import { getMintDecoder } from '@solana-program/token-2022';
import { CROSS_BACKING_PROGRAM_ADDRESS, CREATE_POLICY_DISCRIMINATOR } from '@opening-cross/cross-backing-client';
import { CROSS_BASKET_PROGRAM_ADDRESS, CREATE_BASKET_DISCRIMINATOR } from '@opening-cross/cross-basket-client';
import { CROSS_BOUNTY_PROGRAM_ADDRESS, CREATE_BOUNTY_DISCRIMINATOR } from '@opening-cross/cross-bounty-client';
import { CROSS_CONVICTION_PROGRAM_ADDRESS, LOCK_TOKENS_DISCRIMINATOR } from '@opening-cross/cross-conviction-client';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, INIT_CHARTER_DISCRIMINATOR, OUTCOME_DISCRIMINATOR, getOutcomeDecoder } from '@opening-cross/cross-graduate-client';
import { CROSS_LISTING_PROGRAM_ADDRESS, CREATE_VENUE_DISCRIMINATOR } from '@opening-cross/cross-listing-client';
import { CROSS_MANDATE_PROGRAM_ADDRESS, CREATE_MANDATE_DISCRIMINATOR } from '@opening-cross/cross-mandate-client';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, type CrossView, GRADUATE_VENUES, ProgramRefusal, isGoverned, outcomeAddress, type ProgramIssue, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, readRuledCross } from '@opening-cross/sdk';
import { type Lifetime, RequestError, type UnsignedTx } from '../tx.js';
import { type ReleaseGate, compileFitting, releaseGate } from './program-gate.js';
import { OPEN_DBC_POOL_DISCRIMINATOR, SEED_FUTARCHY_DAO_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { loadsDiscriminator } from './holder-programs.js';

export type ChainAccount = { data: Uint8Array; owner: Address };
export type AccountReader = (a: Address) => Promise<ChainAccount | null>;
/** The slice of a Postgres pool the read routes use. */
export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export type NewProgramKey = 'crossMandate' | 'crossConviction' | 'crossBasket' | 'crossListing' | 'crossBounty' | 'crossBacking' | 'crossGraduate';
export type NewProgram = { key: NewProgramKey; name: string; address: Address; adr: string; control: { name: string; discriminator: Uint8Array } };

/** The seven programs, each with an instruction every release of it has (the control of the scan). */
export const NEW_PROGRAMS: Record<NewProgramKey, NewProgram> = {
  crossMandate: { key: 'crossMandate', name: 'cross_mandate', address: CROSS_MANDATE_PROGRAM_ADDRESS, adr: 'ADR-0650', control: { name: 'create_mandate', discriminator: CREATE_MANDATE_DISCRIMINATOR as Uint8Array } },
  crossConviction: { key: 'crossConviction', name: 'cross_conviction', address: CROSS_CONVICTION_PROGRAM_ADDRESS, adr: 'ADR-0651', control: { name: 'lock_tokens', discriminator: LOCK_TOKENS_DISCRIMINATOR as Uint8Array } },
  crossBasket: { key: 'crossBasket', name: 'cross_basket', address: CROSS_BASKET_PROGRAM_ADDRESS, adr: 'ADR-0652', control: { name: 'create_basket', discriminator: CREATE_BASKET_DISCRIMINATOR as Uint8Array } },
  crossListing: { key: 'crossListing', name: 'cross_listing', address: CROSS_LISTING_PROGRAM_ADDRESS, adr: 'ADR-0653', control: { name: 'create_venue', discriminator: CREATE_VENUE_DISCRIMINATOR as Uint8Array } },
  crossBounty: { key: 'crossBounty', name: 'cross_bounty', address: CROSS_BOUNTY_PROGRAM_ADDRESS, adr: 'ADR-0654', control: { name: 'create_bounty', discriminator: CREATE_BOUNTY_DISCRIMINATOR as Uint8Array } },
  crossBacking: { key: 'crossBacking', name: 'cross_backing', address: CROSS_BACKING_PROGRAM_ADDRESS, adr: 'ADR-0655', control: { name: 'create_policy', discriminator: CREATE_POLICY_DISCRIMINATOR as Uint8Array } },
  crossGraduate: { key: 'crossGraduate', name: 'cross_graduate', address: CROSS_GRADUATE_PROGRAM_ADDRESS, adr: 'ADR-0656', control: { name: 'init_charter', discriminator: INIT_CHARTER_DISCRIMINATOR as Uint8Array } },
};
export const NEW_PROGRAM_KEYS = Object.keys(NEW_PROGRAMS) as NewProgramKey[];

export type ReleaseState = 'ready' | 'program-missing' | 'instruction-missing' | 'unknown';
/** Whether `instruction` of one of the seven programs exists on the cluster. Tests inject one; by default the program's own bytes are read. */
export type ProgramRelease = (key: NewProgramKey, instruction?: { name: string; discriminator: Uint8Array }) => Promise<ReleaseState>;

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const HEADER = 45; // u32 tag, u64 slot, u8 option, 32-byte upgrade authority

/**
 * The release check over `account`. A definite "ready" or "instruction-missing" is kept for `ttlMs` (default ten minutes: a program changes only when it is
 * upgraded); "program-missing" is kept for 20 seconds only, so a program deployed a moment ago is found at once; "unknown" is asked again at the next call.
 */
export function programRelease(d: { account: AccountReader; clock?: () => number; ttlMs?: number }): ProgramRelease {
  const now = () => (d.clock ? d.clock() * 1000 : Date.now());
  const ttl = d.ttlMs ?? 600_000;
  const kept = new Map<string, { at: number; state: ReleaseState }>();
  return async (key, instruction) => {
    const program = NEW_PROGRAMS[key];
    const k = `${key}:${instruction ? hex(instruction.discriminator) : ''}`;
    const hit = kept.get(k);
    if (hit && now() - hit.at < (hit.state === 'program-missing' ? Math.min(ttl, 20_000) : ttl)) return hit.state;
    const state = await scan(d.account, program, instruction);
    if (state !== 'unknown') kept.set(k, { at: now(), state });
    return state;
  };
}

async function scan(account: AccountReader, program: NewProgram, instruction: { name: string; discriminator: Uint8Array } | undefined): Promise<ReleaseState> {
  try {
    const p = await account(program.address);
    if (!p) return 'program-missing';
    if (p.owner !== LOADER || p.data.length < 36) return 'unknown';
    const data = await account(getAddressDecoder().decode(p.data.subarray(4, 36)));
    if (!data || data.data.length < HEADER + 64) return 'unknown';
    const elf = data.data.subarray(HEADER);
    if (!loadsDiscriminator(elf, program.control.discriminator)) return 'unknown';
    if (!instruction) return 'ready';
    return loadsDiscriminator(elf, instruction.discriminator) ? 'ready' : 'instruction-missing';
  } catch {
    return 'unknown';
  }
}

export type Release = { program: Address; instruction: string; deployed: true | null };

/**
 * Refuses with 409 PROGRAM_NOT_DEPLOYED when the cluster definitely lacks the program or the instruction. Returns what the response should say about the release:
 * `deployed: true` when the instruction was found, `null` when it could not be checked.
 */
export async function requireNew(gate: ProgramRelease, key: NewProgramKey, instruction: { name: string; discriminator: Uint8Array }): Promise<Release> {
  const p = NEW_PROGRAMS[key];
  const state = await gate(key, instruction);
  if (state === 'program-missing') {
    throw new RequestError(409, `The program ${p.name} (${p.address}) is not deployed on this cluster: it is built and proved locally (LiteSVM and a local validator, ${p.adr}) and goes on the cluster when the operations key is funded (docs/HUMAN_TASKS.md H27, H43). GET /v1/programs reports the release.`, {
      reason: 'PROGRAM_NOT_DEPLOYED',
      program: p.address,
      programName: p.name,
      instruction: instruction.name,
    });
  }
  if (state === 'instruction-missing') {
    throw new RequestError(409, `The ${p.name} program on this cluster (${p.address}) does not have the instruction ${instruction.name}. GET /v1/programs reports the release.`, { reason: 'PROGRAM_NOT_DEPLOYED', program: p.address, programName: p.name, instruction: instruction.name });
  }
  return { program: p.address, instruction: instruction.name, deployed: state === 'ready' ? true : null };
}

/** The `release` object of a read: whether the program is on this cluster, never an error. */
export async function releaseNote(gate: ProgramRelease, key: NewProgramKey): Promise<{ program: Address; programName: string; deployed: boolean | null; note?: string }> {
  const p = NEW_PROGRAMS[key];
  const state = await gate(key);
  const deployed = state === 'program-missing' ? false : state === 'unknown' ? null : true;
  return {
    program: p.address,
    programName: p.name,
    deployed,
    ...(deployed === false && { note: `${p.name} is built and proved locally (${p.adr}) and is not deployed on this cluster until the operations key is funded (docs/HUMAN_TASKS.md H27, H43), so there is nothing to read.` }),
    ...(deployed === null && { note: `The ${p.name} program could not be checked just now.` }),
  };
}

/** A typed account read: the account exists, belongs to `owner`, carries `disc`, and decodes. 404 otherwise, with a `reason` the caller can branch on. */
export async function readAccount<T>(account: AccountReader, address: Address, o: { owner: Address; disc: Uint8Array; decode: (b: Uint8Array) => T; what: string; reason: string }): Promise<{ account: ChainAccount; value: T }> {
  const a = await account(address);
  if (!a) throw new RequestError(404, `${o.what} ${address} not found on chain`, { reason: o.reason });
  if (a.owner !== o.owner || a.data.length < 8 || !Array.from(o.disc).every((b, i) => a.data[i] === b)) throw new RequestError(404, `${address} is not ${o.what.startsWith('a') || o.what.startsWith('e') ? 'an' : 'a'} ${o.what}`, { reason: o.reason });
  try {
    return { account: a, value: o.decode(a.data) };
  } catch {
    throw new RequestError(404, `${address} is not ${o.what.startsWith('a') || o.what.startsWith('e') ? 'an' : 'a'} ${o.what} of the layout this API reads`, { reason: o.reason });
  }
}

/** The token program that owns a mint, with the mint's bytes. 404 when it does not exist, 422 when it is not a token mint. */
export async function mintOf(account: AccountReader, mint: Address, field = 'mint'): Promise<{ tokenProgram: Address; data: Uint8Array }> {
  const a = await account(mint);
  if (!a) throw new RequestError(404, `${field} ${mint} not found on chain`, { reason: 'MINT_NOT_FOUND', mint });
  if (a.owner !== SPL_TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) throw new RequestError(422, `${field} ${mint} is not a token mint`, { reason: 'NOT_A_TOKEN_MINT', mint });
  return { tokenProgram: a.owner, data: a.data };
}

/** Extensions of a Token-2022 mint (empty for a legacy mint). */
export function mintExtensions(data: Uint8Array, tokenProgram: Address): string[] {
  if (tokenProgram !== TOKEN_2022_PROGRAM) return [];
  try {
    const m = getMintDecoder().decode(data);
    return m.extensions.__option === 'Some' ? m.extensions.value.map((e) => e.__kind) : [];
  } catch {
    return [];
  }
}

/** Reads the raw amount of a token account (the 64-bit field at offset 64), or null when it does not exist or is not a token account. */
export async function tokenBalance(account: AccountReader, tokenAccount: Address): Promise<bigint | null> {
  const a = await account(tokenAccount);
  if (!a || a.data.length < 72 || (a.owner !== SPL_TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM)) return null;
  return new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
}

/** The supply of a mint (the 64-bit field at offset 36), or null. */
export async function mintSupply(account: AccountReader, mint: Address): Promise<bigint | null> {
  const a = await account(mint);
  if (!a || a.data.length < 44 || (a.owner !== SPL_TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM)) return null;
  return new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(36, true);
}

/** 422 REFUSED with every issue the program would refuse, as { code, field, message }. */
export function refuseWith(issues: ProgramIssue[], what: string): never {
  throw new RequestError(422, `${what}: ${issues.map((i) => `${i.field}: ${i.message}`).join(' ')}`, { reason: issues[0]!.code.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), issues });
}
export function failIf(issues: ProgramIssue[], what: string): void {
  if (issues.length > 0) refuseWith(issues, what);
}

/** One transaction built from `ixs`, measured against the size limit, with the sizes and signers the screens need. */
export function oneTx(payer: Address, ixs: Instruction[], lifetime: Lifetime, what: string): UnsignedTx & { bytes: number } {
  return compileFitting(payer, ixs, lifetime, what);
}

/** Runs a builder; a `ProgramRefusal` (facts the program would reject) becomes a 422 that carries every issue. */
export async function building<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ProgramRefusal) refuseWith(e.issues, 'The program would refuse this');
    throw e;
  }
}

/** A cross read from chain with its rules tail. 404 when it is not an Opening Cross account. */
export async function readCross(account: AccountReader, a: Address): Promise<CrossView> {
  const acct = await account(a);
  if (!acct) throw new RequestError(404, `cross ${a} not found on chain`, { reason: 'NO_SUCH_CROSS' });
  if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || acct.data.length < 8 || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) throw new RequestError(404, `${a} is not an Opening Cross account`, { reason: 'NO_SUCH_CROSS' });
  return readRuledCross(a, acct.data);
}

/** `AccountReader` calls that may fail transiently are not retried here: a failure is the RPC's, and the caller sees a 503 from the error handler. */
export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * Whether a cross can be created with the governed-graduation rule (flag 32) and then graduate: `cross_graduate` must be on the cluster and `cross_settle` must have
 * the batch 2 gate (`seed_futarchy_dao` is its marker; every seeding instruction of that build carries the gate). The fifth flag of `cross_core` is a bit in an existing
 * mask and cannot be seen in the program bytes, so it is reported as unverified, never as present. `ready: false` means a part is definitely missing.
 */
export async function governedGraduationState(d: { account: AccountReader; gate: ProgramRelease; settleGate: ReleaseGate }): Promise<{ ready: boolean | null; missing: string[] }> {
  const missing: string[] = [];
  let unknown = false;
  const graduate = await d.gate('crossGraduate');
  if (graduate === 'program-missing' || graduate === 'instruction-missing') missing.push('cross_graduate is not deployed');
  else if (graduate === 'unknown') unknown = true;
  let settleProgram: ChainAccount | null | undefined;
  try {
    settleProgram = await d.account(CROSS_SETTLE_PROGRAM_ADDRESS);
  } catch {
    settleProgram = undefined;
  }
  if (settleProgram === null) missing.push('cross_settle is not deployed');
  else if (settleProgram === undefined) unknown = true;
  else {
    const settle = await d.settleGate(CROSS_SETTLE_PROGRAM_ADDRESS, { name: 'seed_futarchy_dao', discriminator: SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array }, OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array);
    if (settle === 'absent') missing.push('cross_settle does not have the batch 2 upgrade (the governed-graduation gate)');
    else if (settle === 'unknown') unknown = true;
  }
  return { ready: missing.length > 0 ? false : unknown ? null : true, missing };
}

/** The default release gate for `cross_settle` instructions, shared by the routes that need it. */
export const settleReleaseGate = (d: { account: AccountReader; clock?: () => number }): ReleaseGate => releaseGate({ account: d.account, ...(d.clock && { clock: d.clock }) });

const SEEDING_ROUTE = ['seed-damm-v2', 'open-dlmm-pair', 'seed-raydium-cpmm', 'seed-futarchy-dao'] as const;

/**
 * The gate every seeding instruction of `cross_settle` applies to a governed cross (ADR-0656), made before a transaction is handed out: the cross's `Outcome` account must
 * exist, belong to `cross_graduate`, be for this cross and name `venue`. An ungoverned cross is untouched. 409 GRADUATION_NOT_APPROVED otherwise, saying which of the cases it is
 * and, when the vote chose another venue, which route opens that one.
 */
export async function requireGraduationApproval(account: AccountReader, cross: CrossView, venue: number): Promise<{ governed: false } | { governed: true; outcome: Address; venue: string }> {
  if (!isGoverned(cross.ext)) return { governed: false };
  const address = await outcomeAddress(cross.address);
  const wanted = GRADUATE_VENUES[venue]!;
  const refuse = (why: 'NO_OUTCOME' | 'WRONG_VENUE', message: string, extra: Record<string, unknown> = {}) => {
    throw new RequestError(409, message, { reason: 'GRADUATION_NOT_APPROVED', why, outcome: address, venue: wanted, ...extra });
  };
  const a = await account(address);
  if (!a || a.owner !== CROSS_GRADUATE_PROGRAM_ADDRESS || !(OUTCOME_DISCRIMINATOR as Uint8Array).every((b, i) => a.data[i] === b)) {
    return refuse('NO_OUTCOME', `This cross set the governed-graduation rule: it opens a pool only on the venue its holders voted for, and no vote has passed (no outcome is published at ${address}). GET /v1/crosses/${cross.address}/graduation shows the vote.`);
  }
  const outcome = getOutcomeDecoder().decode(a.data);
  if (outcome.cross !== cross.address) return refuse('NO_OUTCOME', `The outcome account at ${address} is for another cross.`);
  if (outcome.venue !== venue) {
    const chosen = GRADUATE_VENUES[outcome.venue] ?? `venue ${outcome.venue}`;
    const route = SEEDING_ROUTE[outcome.venue];
    return refuse('WRONG_VENUE', `The holders voted for ${chosen}, not ${wanted}.${route ? ` Open it with POST /v1/tx/${route}.` : ''}`, { chosen, ...(route && { route: `/v1/tx/${route}` }) });
  }
  return { governed: true, outcome: address, venue: wanted };
}
