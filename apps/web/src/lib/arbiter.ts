// The arbiter's side of issuer neutrality (VM7): who the arbiter is, which challenges wait for a ruling, and the ruling as the body of
// POST /v1/tx/resolve-challenge. Pure parts are unit-tested; the reads go through the same RPC and API the other pages use.
//
// Rules of the program (programs/cross_core/src/neutral.rs, docs/evidence/W2D-VM7.md): the protocol admin names one arbiter with `set_arbiter`
// (the registry account is a PDA of the seed "arbiter"); only that wallet can rule on a challenge. An upheld ruling slashes up to the bond held:
// half goes to the challenger, half to the protocol, and the challenger's deposit comes back. A rejected ruling slashes nothing and the deposit
// goes to the protocol. A challenge nobody rules on for 14 days can be closed by anyone and the deposit goes back to the challenger.
import { type Address, address, getAddressDecoder, getProgramDerivedAddress } from '@solana/kit';
import { RPC_URL } from './config';
import { type Protocol, CROSS_CORE, decodeProtocol, protocolAddress, rpcBatch } from './power';
import { atomsOf, fmt } from './issuer-treasury-console';

export type ChallengeStatus = 'Open' | 'Upheld' | 'Rejected' | 'Expired';
export type Challenge = { id: number; challenger: string; subject: string; evidence: string; status: ChallengeStatus; slash: string | null; filed_slot?: string; resolved_slot?: string | null };

export const EXPIRY_DAYS = 14;

export type ArbiterRead = { state: 'named'; arbiter: string } | { state: 'none' } | { state: 'unread'; reason: string };

type Raw = { value: { owner: string; data: [string, string] } | null } | undefined;
const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function arbiterRegistryAddress(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: address(CROSS_CORE), seeds: [new TextEncoder().encode('arbiter')] }))[0];
}

/** ArbiterRegistry: an 8-byte discriminator, the arbiter, a bump. No account yet means no arbiter has been named (HUMAN_TASKS H28). */
export function decodeArbiterRegistry(data: Uint8Array): string | null {
  return data.length >= 8 + 32 ? getAddressDecoder().decode(data.slice(8, 40)) : null;
}

export async function readArbiter(): Promise<ArbiterRead> {
  try {
    const [r] = (await rpcBatch(RPC_URL, [{ method: 'getAccountInfo', params: [await arbiterRegistryAddress(), { encoding: 'base64', commitment: 'confirmed' }] }])) as [Raw];
    if (!r || !r.value) return { state: 'none' };
    if (r.value.owner !== CROSS_CORE) return { state: 'unread', reason: 'The account at the arbiter registry address is not owned by cross_core.' };
    const a = decodeArbiterRegistry(b64(r.value.data[0]));
    return a ? { state: 'named', arbiter: a } : { state: 'unread', reason: 'The arbiter registry account is shorter than expected.' };
  } catch (e) {
    return { state: 'unread', reason: e instanceof Error ? e.message : 'The network could not be reached.' };
  }
}

export type AdminRead = { ok: true; protocol: Protocol } | { ok: false; reason: string };
export async function readAdmin(): Promise<AdminRead> {
  try {
    const [r] = (await rpcBatch(RPC_URL, [{ method: 'getAccountInfo', params: [await protocolAddress(), { encoding: 'base64', commitment: 'confirmed' }] }])) as [Raw];
    if (!r || !r.value) return { ok: false, reason: 'The protocol account does not exist on this network.' };
    const p = decodeProtocol(b64(r.value.data[0]));
    return p ? { ok: true, protocol: p } : { ok: false, reason: 'The protocol account could not be decoded.' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'The network could not be reached.' };
  }
}

export const STATUS_TEXT: Record<ChallengeStatus, string> = {
  Open: 'Waiting for the arbiter',
  Upheld: 'Upheld: part of the bond was slashed',
  Rejected: 'Rejected: the deposit went to the protocol',
  Expired: 'Closed unanswered: the deposit went back to the challenger',
};

export type RulingForm = { decision: 'uphold' | 'reject'; slash: string };
export const EMPTY_RULING: RulingForm = { decision: 'reject', slash: '' };
export type RulingBuild = { body: Record<string, unknown> | null; error: string | null; sentence: string | null };

/**
 * The ruling as a request, checked the way the API checks it: a slash is at most the bond still held, and only an upheld ruling slashes.
 * `sentence` says what the ruling will do with the money, so the arbiter reads the consequence before signing.
 */
export function buildRuling(f: RulingForm, c: { cross: string; id: number; arbiter: string | null; bondHeld: string | null; quoteDecimals: number | null }): RulingBuild {
  if (!c.arbiter) return { body: null, error: null, sentence: null };
  const base = { cross: c.cross, arbiter: c.arbiter, id: c.id };
  if (f.decision === 'reject') {
    if (f.slash.trim() !== '' && f.slash.trim() !== '0') return { body: null, error: 'A rejected challenge slashes nothing. Clear the amount, or uphold the challenge.', sentence: null };
    return { body: { ...base, upheld: false }, error: null, sentence: 'Rejecting sends the challenger’s deposit to the protocol and slashes nothing from the bond.' };
  }
  if (f.slash.trim() === '') return { body: null, error: 'Say how much of the bond to slash (it can be 0).', sentence: null };
  const slash = f.slash.trim() === '0' ? ({ ok: true, atoms: '0' } as const) : atomsOf(f.slash, c.quoteDecimals, 'The slash', { allowZero: true });
  if (!slash.ok) return { body: null, error: slash.error, sentence: null };
  if (c.bondHeld !== null && BigInt(slash.atoms) > BigInt(c.bondHeld)) return { body: null, error: `A slash is at most the bond still held, ${fmt(c.bondHeld, c.quoteDecimals, 'quote')}.`, sentence: null };
  const half = BigInt(slash.atoms) / 2n;
  return {
    body: { ...base, upheld: true, slash: slash.atoms },
    error: null,
    sentence: `Upholding returns the challenger’s deposit and slashes ${fmt(slash.atoms, c.quoteDecimals, 'quote')} from the bond: ${fmt(half.toString(), c.quoteDecimals, 'quote')} to the challenger and the rest to the protocol.`,
  };
}

/** A role-aware sentence about the connected wallet. */
export function standingText(a: ArbiterRead, wallet: string | null): string {
  if (a.state === 'unread') return `The arbiter could not be read just now (${a.reason}).`;
  if (a.state === 'none') return 'No arbiter has been named yet, so no challenge can be ruled on. Until the protocol admin names one, an unanswered challenge can only be closed after 14 days, which returns the deposit.';
  if (!wallet) return 'Connect a wallet to see whether it is the arbiter.';
  return wallet === a.arbiter ? 'This wallet is the arbiter. It can rule on the challenges below.' : 'This wallet is not the arbiter. You can read the challenges; only the arbiter can rule on them.';
}
