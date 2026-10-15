// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// Resale locks (ADR-0900). A lock stops a wallet's balance of the gated token from falling below `amount` before
// `unlockTs`. Two things create one: the gate authority (or the keeper named as `lockDelegate` in the rules) with
// `set_lock`, which can only strengthen an active lock, and the cross program with `receive_locked`, which applies the
// rules' lock policy to tokens a gated cross has just paid out.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { findConfigPda, getReceiveLockedInstruction, getSetLockInstruction } from './generated/index';
import { findLockAddress } from './pdas';

/** `set_lock` for a wallet. Signed by the gate authority or by the rules' lock delegate. */
export async function setLock(i: { authority: TransactionSigner; mint: Address; owner: Address; amount: bigint; unlockTs: bigint }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [lock] = await findLockAddress(i.mint, i.owner);
  return getSetLockInstruction({ authority: i.authority, config, lock, owner: i.owner, amount: i.amount, unlockTs: i.unlockTs });
}

/**
 * `receive_locked`: what `cross_core` calls after a gated cross pays `amount` tokens to `owner`. `cross` must be the
 * cross account, signing as the PDA of `cross_core`; a wallet cannot call this. It is built here so the program that makes
 * the call and the tests that stand in for it use one encoding.
 */
export async function receiveLocked(i: { payer: TransactionSigner; cross: TransactionSigner; mint: Address; owner: Address; amount: bigint }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [lock] = await findLockAddress(i.mint, i.owner);
  return getReceiveLockedInstruction({ payer: i.payer, cross: i.cross, config, lock, owner: i.owner, amount: i.amount });
}

/**
 * When a lock set at `now` ends, and for how much, under a lock policy of `durationSecs`. For a keeper that applies the
 * policy through `set_lock` rather than through `cross_core`: the lock must cover the received amount plus any lock still
 * running, and end no earlier than the one running.
 */
export function resaleLock(i: { now: bigint; durationSecs: bigint; received: bigint; current?: { amount: bigint; unlockTs: bigint } | null }): { amount: bigint; unlockTs: bigint } {
  if (i.durationSecs <= 0n) throw new Error('durationSecs must be positive');
  const ends = i.now + i.durationSecs;
  const active = i.current && i.current.unlockTs > i.now ? i.current : null;
  return active ? { amount: active.amount + i.received, unlockTs: active.unlockTs > ends ? active.unlockTs : ends } : { amount: i.received, unlockTs: ends };
}
