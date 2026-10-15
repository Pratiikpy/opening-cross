// Conviction locks and the soulbound badge (S7; ADR-0651): what the conviction routes serve, the words a holder reads, and the forms that become the bodies of the
// routes. Pure and free of React. Integers that can exceed 2^53 are decimal strings; times are Unix seconds.
//
// Rules of the program (programs/cross_conviction, docs/evidence/W3D-S7.md): a lock moves tokens into a vault and records what arrived. Nothing moves them before the
// unlock time (one day to four years away), not the holder and not the program; `unlock` returns them after it. `claim_badge`, once per lock after the unlock time, mints
// whole token-days (amount x lock seconds / 86,400 / 10^decimals, rounded down) of a non-transferable badge: a credential in the wallet, not points, tiers or a payout.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms } from './units';

export const MIN_LOCK_DAYS = 1;
export const MAX_LOCK_DAYS = 1459;
export type LockState = 'locked' | 'unlockable' | 'unlocked';
export type LockRow = { lock: string; mint: string; amount: string; lockedAt: number; unlockTs: number; state: LockState; badgeClaimed: boolean; tokenDays: string | null };
export type BadgeRow = { mint: string; badgeMint: string; tokenDays: string | null };
export type ConvictionRead = { owner: string; locks: LockRow[]; badges: BadgeRow[]; release: ReleaseNote; note?: string };
export type MintStats = { mint: string; locks: number; holders: number; locked: string; tokenDaysClaimed: string; release: ReleaseNote };

/** Whole token-days of a lock of `amount` atoms for `seconds`: the program's rounding (down). */
export function tokenDays(amount: bigint, seconds: number, decimals: number): bigint {
  return (amount * BigInt(Math.max(0, seconds))) / (86_400n * 10n ** BigInt(decimals));
}

export function timeLeft(unlockTs: number, now: number): string {
  const s = unlockTs - now;
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3_600) / 60)}m`;
}

/** What a holder can do with a lock next. */
export type NextStep = 'wait' | 'unlock' | 'claim' | 'unlock-and-claim' | 'close' | 'done';
export function nextStepOf(l: LockRow, tokenDaysEarned: bigint | null): NextStep {
  if (l.state === 'locked') return 'wait';
  const canBadge = !l.badgeClaimed && tokenDaysEarned !== null && tokenDaysEarned > 0n;
  if (l.state === 'unlockable') return canBadge ? 'unlock-and-claim' : 'unlock';
  if (canBadge) return 'claim';
  return l.badgeClaimed ? 'close' : 'done';
}

export type LockForm = { mint: string; amount: string; days: string };
export const EMPTY_LOCK: LockForm = { mint: '', amount: '', days: '90' };
export type LockErrors = Partial<Record<keyof LockForm, string>>;

/** The body of POST /v1/tx/conviction-lock. */
export function buildLock(f: LockForm, holder: string | null, decimals: number | null, held: bigint | null, now: number): { body: Record<string, unknown> | null; errors: LockErrors; days: bigint | null } {
  const errors: LockErrors = {};
  if (!isAddress(f.mint.trim())) errors.mint = 'This is not a Solana address.';
  const amount = decimals === null ? null : parseAtoms(f.amount, decimals);
  if (f.amount.trim() === '' || amount === null || amount === 0n) errors.amount = decimals === null ? 'The token’s decimals have not been read yet.' : `A number above zero with at most ${decimals} decimals.`;
  else if (held !== null && amount > held) errors.amount = `This wallet holds ${formatAtoms(held, decimals ?? 0)}.`;
  const d = /^\d{1,4}$/.test(f.days.trim()) ? Number(f.days.trim()) : null;
  if (d === null || d < MIN_LOCK_DAYS || d > MAX_LOCK_DAYS) errors.days = `A lock lasts a whole number of days, ${MIN_LOCK_DAYS} to ${MAX_LOCK_DAYS} (a little under four years, the longest a lock can be).`;
  const days = amount !== null && d !== null && decimals !== null ? tokenDays(amount, d * 86_400, decimals) : null;
  if (Object.keys(errors).length > 0 || !holder || amount === null || d === null) return { body: null, errors, days };
  // One minute of margin, so the lock is never shorter than the days named when the transaction lands.
  return { body: { holder, mint: f.mint.trim(), amount: amount.toString(), unlockTs: now + d * 86_400 + 60 }, errors, days };
}
