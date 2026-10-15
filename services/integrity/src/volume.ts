// When to state a volume: a pure decision over what the attester knows. The attester states the LOWER bound of organic volume and only when the guard passes; it retracts a
// figure it can no longer stand behind; and it says nothing when the evidence is incomplete, because a figure it cannot support is worse than silence (the charter's
// minimum then simply is not met, which is the safe direction).
import type { Address } from '@solana/kit';
import type { GuardResult } from '@opening-cross/integrity';

export type VolumeDecision =
  | { post: true; volume: bigint; reason: 'FIRST_STATEMENT' | 'CHANGED' | 'LOWERED' | 'RETRACTED' }
  | { post: false; reason: 'NOT_OUR_ROUND' | 'ROUND_FINALIZED' | 'HELD' | 'FAILED_NOTHING_POSTED' | 'UNCHANGED' | 'JUMP_TOO_LARGE'; detail?: string };

export type VolumeFacts = {
  signer: Address;
  round: { volumeAttester: Address | null; finalized: boolean; volumeSet: boolean; volumeQuote: bigint };
  guard: Pick<GuardResult, 'decision' | 'reasons'>;
  /** The lower-bound volume in quote atoms, valid when the guard passed. */
  lowerQuote: bigint;
};

export function planVolume(f: VolumeFacts, c: { minChangeBps: number; maxIncreaseFactor: number }): VolumeDecision {
  if (f.round.volumeAttester !== f.signer) return { post: false, reason: 'NOT_OUR_ROUND' };
  if (f.round.finalized) return { post: false, reason: 'ROUND_FINALIZED' };
  const posted = f.round.volumeSet ? f.round.volumeQuote : null;
  if (f.guard.decision === 'fail') {
    // A figure already stated is withdrawn (set to zero) the moment the facts show it was inflated; if none was stated there is nothing to take back.
    return posted !== null && posted > 0n ? { post: true, volume: 0n, reason: 'RETRACTED' } : { post: false, reason: 'FAILED_NOTHING_POSTED', detail: f.guard.reasons.map((r) => r.message).join(' ') };
  }
  if (f.guard.decision === 'hold') return { post: false, reason: 'HELD', detail: f.guard.reasons.map((r) => r.message).join(' ') };
  const v = f.lowerQuote;
  if (posted === null) return { post: true, volume: v, reason: 'FIRST_STATEMENT' };
  // A lower figure replaces a higher one at once: the earlier statement overstated what can be shown.
  if (v < posted) return { post: true, volume: v, reason: 'LOWERED' };
  if (v === posted) return { post: false, reason: 'UNCHANGED' };
  if (c.maxIncreaseFactor > 0 && posted > 0n && v > posted * BigInt(Math.ceil(c.maxIncreaseFactor))) return { post: false, reason: 'JUMP_TOO_LARGE', detail: `${v} is more than ${c.maxIncreaseFactor} times the last statement (${posted}); held for an operator` };
  const moved = v - posted;
  if (posted === 0n || moved * 10_000n >= posted * BigInt(c.minChangeBps)) return { post: true, volume: v, reason: 'CHANGED' };
  return { post: false, reason: 'UNCHANGED' };
}
