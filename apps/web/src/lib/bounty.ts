// The adversarial bounty (X10; ADR-0654): what the bounty routes serve, the words a sponsor and a hunter read, and the forms that become the bodies of the routes.
// Pure and free of React. Integers that can exceed 2^53 are decimal strings; times are Unix seconds.
//
// Rules of the program (programs/cross_bounty, docs/evidence/W3D-X10.md): a bounty fixes for good the reward token, an arbiter, an expiry at least thirty days away
// and a reward per invariant (eleven). Anyone can fund it. It pays automatically to whoever shows a cross_core cross account that breaks one of eleven invariants
// (each pays once), and by the arbiter, up to the pool and only before the expiry, for what the chain cannot check. The sponsor can withdraw only after the expiry.
// Eleven invariants are not a proof of correctness: a theft path or a rounding exploit with real funds is the arbiter's part.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms, shortAddress } from './units';

export const INVARIANT_COUNT = 11;
/** The eleven invariants, in the program's order (packages/sdk BOUNTY_INVARIANT_NAMES; a test compares them). */
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
export type InvariantRow = { invariant: number; name: string; reward: string; covered: boolean; paid: boolean };
export type BountyRow = { bounty: string; sponsor: string; arbiter: string; rewardMint: string; expiresAt: number; status: 'open' | 'expired'; rewards: string[]; funded: string; paid: string; awarded: string; withdrawn: string; paidMask: number };
export type BountiesRead = { bounties: BountyRow[]; release: ReleaseNote; note?: string };
export type BountyRead = { bounty: string; sponsor: string; id: string; arbiter: string; rewardMint: string; vault: string; pool: string | null; expiresAt: string; status: 'open' | 'empty' | 'expired'; secondsLeft: string; paidMask: number; awarded: string; invariants: InvariantRow[]; release: ReleaseNote };
export type PayoutRow = { kind: 'invariant' | 'award'; invariant: number | null; invariantName: string | null; cross: string | null; recipient: string; amount: string; evidence: string | null; slot: string };
export type PayoutsRead = { bounty: string; payouts: PayoutRow[]; release: ReleaseNote };
export type InvariantsRead = { cross: string; checked: number; broken: { invariant: number; name: string }[]; honest: boolean; note: string };

/** The pool a bounty holds, as far as the index can say: what was funded less what was paid out, awarded or withdrawn. */
export function poolOf(b: Pick<BountyRow, 'funded' | 'paid' | 'awarded' | 'withdrawn'>): bigint {
  const v = BigInt(b.funded) - BigInt(b.paid) - BigInt(b.awarded) - BigInt(b.withdrawn);
  return v < 0n ? 0n : v;
}

export const covered = (rewards: string[]): number => rewards.filter((r) => BigInt(r) > 0n).length;

export function expiryText(expiresAt: number, now: number): string {
  const stamp = new Date(expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 16);
  if (now >= expiresAt) return `expired on ${stamp} UTC`;
  const d = Math.floor((expiresAt - now) / 86_400);
  return `commits its pool until ${stamp} UTC (${d} day${d === 1 ? '' : 's'} left)`;
}

// ---------------------------------------------------------------------------------------------------- forms

export type BountyForm = { rewardMint: string; arbiter: string; days: string; rewards: string[] };
export const EMPTY_BOUNTY: BountyForm = { rewardMint: '', arbiter: '', days: '30', rewards: Array.from({ length: INVARIANT_COUNT }, () => '') };
export type BountyErrors = { rewardMint?: string; arbiter?: string; days?: string; rewards: (string | undefined)[]; none?: string };

/** The body of POST /v1/tx/bounty-create. A bounty never changes, and its pool is committed for at least 30 days from now. */
export function buildBounty(f: BountyForm, sponsor: string | null, decimals: number | null, now: number): { body: Record<string, unknown> | null; errors: BountyErrors } {
  const errors: BountyErrors = { rewards: Array.from({ length: INVARIANT_COUNT }, () => undefined) };
  if (!isAddress(f.rewardMint.trim())) errors.rewardMint = 'This is not a Solana address.';
  if (!isAddress(f.arbiter.trim())) errors.arbiter = 'This is not a Solana address.';
  const d = f.days.trim();
  const days = /^\d{1,4}$/.test(d) ? Number(d) : null;
  if (days === null || days < 30) errors.days = 'A bounty commits its pool for at least 30 days.';
  const amounts: (bigint | null)[] = f.rewards.map((r, i) => {
    if (r.trim() === '') return 0n;
    const v = decimals === null ? null : parseAtoms(r, decimals);
    if (v === null) errors.rewards[i] = decimals === null ? 'The reward token’s decimals have not been read yet.' : `A number with at most ${decimals} decimals.`;
    return v;
  });
  if (amounts.every((a) => a === 0n)) errors.none = 'Give a reward for at least one invariant; an empty one is not paid.';
  const bad = errors.rewardMint || errors.arbiter || errors.days || errors.none || errors.rewards.some(Boolean);
  if (bad || !sponsor || days === null || amounts.some((a) => a === null)) return { body: null, errors };
  return { body: { sponsor, rewardMint: f.rewardMint.trim(), arbiter: f.arbiter.trim(), expiresAt: now + days * 86_400, rewards: amounts.map((a) => a!.toString()) }, errors };
}

/** SHA-256 of a report's text, as 64 hex characters: the evidence an award carries. */
export async function hashReport(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export const isEvidence = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s.trim());

export const who = (a: string | null | undefined): string => (a ? shortAddress(a) : 'nobody');
export const fmt = (atoms: string | bigint, decimals: number | null): string => (decimals === null ? String(atoms) : formatAtoms(BigInt(atoms), decimals));
