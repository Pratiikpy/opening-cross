// When to post a statement: a pure decision over what the attester knows. The rule is that the attester states the truth often enough that a healthy asset never goes stale, and states nothing
// it was not told: a failing source is not worked around (the statement ages out and the watchdog halts the asset, which is the safe outcome), and a figure far above the last one is held back
// until the operator has looked, because an overstated reserve is the one error that gives false comfort.
import type { Address } from '@solana/kit';
import type { AttesterConfig } from './config.js';

export type Decision =
  | { post: true; reason: 'FIRST_STATEMENT' | 'REFRESH' | 'CHANGED' }
  | { post: false; reason: 'FRESH_ENOUGH' | 'TOO_SOON' | 'JUMP_TOO_LARGE' | 'NOT_OUR_POLICY' };

export type PlanFacts = {
  /** The key this attester signs with, and the attester the policy names. */
  signer: Address;
  policy: { attester: Address; maxAgeSecs: bigint };
  last: { backingAtoms: bigint; postedTs: bigint } | null;
  observed: bigint;
  now: bigint;
};

export function planAttestation(f: PlanFacts, c: Pick<AttesterConfig, 'refreshFraction' | 'minChangeBps' | 'minIntervalSecs' | 'maxIncreaseFactor'>): Decision {
  if (f.policy.attester !== f.signer) return { post: false, reason: 'NOT_OUR_POLICY' };
  if (!f.last) return { post: true, reason: 'FIRST_STATEMENT' };
  const age = f.now - f.last.postedTs;
  // The program refuses nothing here, so the rate limit is ours: a statement is a transaction fee.
  if (age >= 0n && age < BigInt(c.minIntervalSecs)) return { post: false, reason: 'TOO_SOON' };
  if (c.maxIncreaseFactor > 0 && f.last.backingAtoms > 0n && f.observed > f.last.backingAtoms * BigInt(Math.ceil(c.maxIncreaseFactor))) return { post: false, reason: 'JUMP_TOO_LARGE' };
  // A statement dated in the future says nothing about now (the program calls it stale), so it is replaced at once.
  if (age < 0n) return { post: true, reason: 'REFRESH' };
  if (Number(age) >= c.refreshFraction * Number(f.policy.maxAgeSecs)) return { post: true, reason: 'REFRESH' };
  const base = f.last.backingAtoms;
  const moved = f.observed > base ? f.observed - base : base - f.observed;
  // Relative to the last statement; from zero any figure is a change.
  if (base === 0n ? f.observed !== 0n : moved * 10_000n >= base * BigInt(c.minChangeBps)) return { post: true, reason: 'CHANGED' };
  return { post: false, reason: 'FRESH_ENOUGH' };
}
