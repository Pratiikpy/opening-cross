// Builders for `cross_conviction` (S7; ADR-0651): tokens locked with no early exit, and a soulbound Token-2022 badge that measures the token-days
// the holder kept locked. Nothing moves the vault's tokens before `unlock_ts`, not for the holder and not for the program.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  CROSS_CONVICTION_PROGRAM_ADDRESS,
  type Lock,
  findBadgeAuthorityPda,
  findBadgeMintPda,
  findLockPda,
  getClaimBadgeInstruction,
  getCloseLockInstruction,
  getInitBadgeInstruction,
  getLockTokensInstruction,
  getUnlockInstruction,
} from '@opening-cross/cross-conviction-client';
import { ata } from '../index.js';
import { type ProgramIssue, SECS_PER_DAY, TOKEN_2022_PROGRAM, createAtaIdempotent, refuse } from './common.js';

export { CROSS_CONVICTION_PROGRAM_ADDRESS };
export type { Lock };

/** A lock lasts at least a day and at most four years (the program's `MIN_LOCK_SECS`, `MAX_LOCK_SECS`). */
export const CONVICTION_MIN_LOCK_SECS = 86_400n;
export const CONVICTION_MAX_LOCK_SECS = 4n * 365n * 86_400n;

/** Whole token-days a lock earns: `floor(amount x seconds / (86,400 x 10^decimals))`, the program's `token_days`. Null when it overflows a u64. */
export function convictionTokenDays(amount: bigint, secs: bigint, decimals: number): bigint | null {
  if (secs <= 0n) return 0n;
  const days = (amount * secs) / (SECS_PER_DAY * 10n ** BigInt(decimals));
  return days > (1n << 64n) - 1n ? null : days;
}

/** What `lock_tokens` refuses, from the amount and the unlock time against `now`. */
export function checkConvictionLock(amount: bigint, unlockTs: bigint, now: bigint): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (!(amount > 0n)) out.push({ code: 'NothingToLock', field: 'amount', message: 'lock a positive amount' });
  if (unlockTs < now + CONVICTION_MIN_LOCK_SECS || unlockTs > now + CONVICTION_MAX_LOCK_SECS) out.push({ code: 'BadUnlockTime', field: 'unlockTs', message: 'the unlock time is between one day and four years from now' });
  return out;
}

export type ConvictionAddresses = { lock: Address; vault: Address };
export async function convictionAddresses(holder: Address, mint: Address, nonce: bigint, tokenProgram: Address): Promise<ConvictionAddresses> {
  const [lock] = await findLockPda({ holder, mint, nonce });
  return { lock, vault: await ata(lock, mint, tokenProgram) };
}
export async function convictionBadgeAddresses(holder: Address, mint: Address): Promise<{ badgeMint: Address; badgeAuthority: Address; holderBadge: Address }> {
  const [badgeMint] = await findBadgeMintPda({ holder, mint });
  const [badgeAuthority] = await findBadgeAuthorityPda();
  return { badgeMint, badgeAuthority, holderBadge: await ata(holder, badgeMint, TOKEN_2022_PROGRAM) };
}

/** `lock_tokens`. `tokenProgram` is the locked token's (legacy or Token-2022); a token with a transfer hook needs its hook accounts, which this builder does not add. */
export async function buildLockTokens(input: { holder: TransactionSigner; mint: Address; tokenProgram: Address; nonce: bigint; amount: bigint; unlockTs: bigint; now?: bigint }): Promise<{ instruction: Instruction } & ConvictionAddresses> {
  const { holder, mint, tokenProgram, nonce, amount, unlockTs } = input;
  refuse(checkConvictionLock(amount, unlockTs, input.now ?? BigInt(Math.floor(Date.now() / 1000))));
  const a = await convictionAddresses(holder.address, mint, nonce, tokenProgram);
  const instruction = getLockTokensInstruction({ holder, mint, holderToken: await ata(holder.address, mint, tokenProgram), lock: a.lock, vault: a.vault, tokenProgram, nonce, amount, unlockTs });
  return { instruction, ...a };
}

/** `unlock`: the tokens back to the holder after `unlock_ts`, and the vault closed. Creates the holder's token account first if asked. */
export async function buildUnlock(input: { holder: TransactionSigner; mint: Address; tokenProgram: Address; lock: ConvictionAddresses; createDestination?: boolean }): Promise<Instruction[]> {
  const { holder, mint, tokenProgram, lock } = input;
  const dest = await ata(holder.address, mint, tokenProgram);
  const ix = getUnlockInstruction({ holder, lock: lock.lock, mint, vault: lock.vault, holderToken: dest, tokenProgram });
  return input.createDestination ? [createAtaIdempotent(holder, holder.address, mint, tokenProgram, dest), ix] : [ix];
}

/** The claim transaction: `init_badge` (idempotent), the holder's badge account (idempotent), `claim_badge`. */
export async function buildClaimBadge(input: { holder: TransactionSigner; mint: Address; lock: Address }): Promise<Instruction[]> {
  const { holder, mint, lock } = input;
  const b = await convictionBadgeAddresses(holder.address, mint);
  return [
    getInitBadgeInstruction({ payer: holder, holder: holder.address, mint, badgeMint: b.badgeMint, badgeAuthority: b.badgeAuthority }),
    createAtaIdempotent(holder, holder.address, b.badgeMint, TOKEN_2022_PROGRAM, b.holderBadge),
    getClaimBadgeInstruction({ holder, lock, mint, badgeMint: b.badgeMint, badgeAuthority: b.badgeAuthority, holderBadge: b.holderBadge }),
  ];
}

/** `close_lock`: returns the lock account's rent once the tokens are back and the badge is claimed. */
export function buildCloseLock(input: { holder: TransactionSigner; lock: Address }): Instruction {
  return getCloseLockInstruction({ holder: input.holder, lock: input.lock });
}
