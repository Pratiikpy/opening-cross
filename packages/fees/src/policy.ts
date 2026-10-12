// What the protocol does with the protocol fee it collects (PRODUCT_FEATURES W6, W7, Y7). Three destinations, applied
// to each finalized cross whose ledger entry matched the chain:
//   referrals    10% of the protocol fee that referred orders generated (see referral.ts)
//   rebate pool  25% of the protocol fee on reopen crosses, reserved for registered market makers (W7)
//   operating    the rest
// The market-maker bot the company runs itself is paid from its own budget, never from the rebate pool (Y7), and its
// volume is reported apart (scorecard.ts): the pool is for outside makers.
import type { LedgerEntry } from './ledger.js';
import { BPS } from './schedule.js';

export const REBATE_SHARE_BPS = 2_500;

export type Allocation = { readonly gross: bigint; readonly referrals: bigint; readonly rebatePool: bigint; readonly operating: bigint };

/** Allocation of one cross's protocol fee. `referrals` is the sum of the cross's referral payouts, already capped by `referralLines`. */
export function allocateProtocolFee(kind: string, protocolFee: bigint, referrals: bigint): Allocation {
  const rebatePool = kind === 'reopen' ? (protocolFee * BigInt(REBATE_SHARE_BPS)) / BPS : 0n;
  const operating = protocolFee - referrals - rebatePool;
  if (operating < 0n) throw new RangeError(`allocations exceed the protocol fee: ${referrals} + ${rebatePool} > ${protocolFee}`);
  return { gross: protocolFee, referrals, rebatePool, operating };
}

/** Per quote mint, the allocation over all matched entries. */
export function allocateAll(entries: readonly LedgerEntry[], referralsByCross: ReadonlyMap<string, bigint> = new Map()): Record<string, Allocation> {
  const out: Record<string, { gross: bigint; referrals: bigint; rebatePool: bigint; operating: bigint }> = {};
  for (const e of entries) {
    if (e.verdict !== 'MATCH') continue;
    const a = allocateProtocolFee(e.facts.kind, e.recorded.protocolFee, referralsByCross.get(e.facts.cross) ?? 0n);
    const t = (out[e.facts.quoteMint] ??= { gross: 0n, referrals: 0n, rebatePool: 0n, operating: 0n });
    t.gross += a.gross;
    t.referrals += a.referrals;
    t.rebatePool += a.rebatePool;
    t.operating += a.operating;
  }
  return out;
}
