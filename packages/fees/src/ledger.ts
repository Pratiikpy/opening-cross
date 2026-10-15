// The revenue ledger: one entry per finalized cross, built from three independent sources that must agree.
//   1. the cross account's own counters, run through the program's fee rules (`expected`),
//   2. the CrossFinalized event the indexer recorded (`recorded`),
//   3. the token balance changes of the finalize transaction itself (`chain`).
// An entry is MATCH only when all three agree to the atom. Anything else is MISMATCH with the reason; a ledger line
// that could not be checked against the chain is UNVERIFIED, never silently counted as verified.
import { type TransferCheck, type TransactionBalances, checkFinalizeTransfers } from './chain.js';
import { type CrossKind, type FeeSplit, MAX_REFERRAL_BPS, type SupplyMode, expectedFinalizeDistribution, referralShare } from './schedule.js';

export type CrossFeeFacts = {
  readonly cross: string;
  readonly creator: string;
  readonly kind: CrossKind;
  readonly supplyMode: SupplyMode;
  readonly quoteMint: string;
  readonly protocolBps: number;
  readonly integratorBps: number;
  readonly integrator: string;
  readonly feeRecipient: string;
  readonly proceedsTo: string;
  readonly buyerPaid: bigint;
  readonly feesAccrued: bigint;
  /** The referrer the cross's rules name (`CrossExt.referral.referrer`), when they name one. A cross of the earlier layout, or one with no referral, leaves both fields out. */
  readonly referrer?: string | undefined;
  /** The referrer's share of the protocol fee in bps (`CrossExt.referral.shareBps`), at most 5,000. */
  readonly referralShareBps?: number | undefined;
};

export type RecordedFinalize = {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds; null when the node did not return a block time. */
  readonly blockTime: number | null;
  readonly protocolFee: bigint;
  readonly integratorFee: bigint;
  readonly proceedsQuote: bigint;
};

export type Verdict = 'MATCH' | 'MISMATCH' | 'UNVERIFIED';

export type LedgerEntry = {
  readonly facts: CrossFeeFacts;
  readonly recorded: RecordedFinalize;
  /** The split of the total fee into the protocol's gross share and the integrator's, which is what the event records. The referral is inside `protocol`. */
  readonly expected: FeeSplit;
  /** The referrer the cross pays at finalize, or null; and the part of `expected.protocol` it receives (0n when none). The fee recipient receives `expected.protocol - referral`. */
  readonly referrer: string | null;
  readonly referral: bigint;
  readonly verdict: Verdict;
  /** Why the verdict is not MATCH. */
  readonly reasons: readonly string[];
  readonly chain: TransferCheck | null;
};

/**
 * Builds one entry. `tx` is the finalize transaction's balances, or null when it could not be fetched.
 * A cross that names a referrer (ADR-0460) pays it `floor(protocol fee x share / 10,000)` out of the protocol fee; the entry expects that transfer, and a
 * transaction that paid the fee recipient the whole protocol fee, or paid the referrer anything else, is a MISMATCH.
 */
export function ledgerEntry(facts: CrossFeeFacts, recorded: RecordedFinalize, tx: TransactionBalances | null): LedgerEntry {
  const reasons: string[] = [];
  const shareBps = facts.referralShareBps ?? 0;
  const shareValid = Number.isInteger(shareBps) && shareBps >= 0 && shareBps <= MAX_REFERRAL_BPS;
  if (!shareValid) reasons.push(`referral: the cross names a share of ${shareBps} bps, above the program's cap of ${MAX_REFERRAL_BPS}`);
  if (shareValid && shareBps > 0 && !facts.referrer) reasons.push('referral: the cross names a share but no referrer');
  const referrer = shareValid && shareBps > 0 && facts.referrer ? facts.referrer : null;
  const dist = expectedFinalizeDistribution({
    supplyMode: facts.supplyMode,
    protocolBps: facts.protocolBps,
    integratorBps: facts.integratorBps,
    buyerPaid: facts.buyerPaid,
    feesAccrued: facts.feesAccrued,
    referralShareBps: referrer ? shareBps : 0,
  });
  const expected: FeeSplit = { total: dist.total, protocol: dist.protocol, integrator: dist.integrator };
  if (expected.protocol !== recorded.protocolFee) reasons.push(`protocol fee: the cross's counters give ${expected.protocol}, the event recorded ${recorded.protocolFee}`);
  if (expected.integrator !== recorded.integratorFee) reasons.push(`integrator fee: the cross's counters give ${expected.integrator}, the event recorded ${recorded.integratorFee}`);
  // The chain is compared with the referral the rules owe on the fee the event recorded, so a wrong event and a wrong transfer are each reported on their own.
  const referral = referrer ? referralShare(recorded.protocolFee, shareBps) : 0n;
  let chain: TransferCheck | null = null;
  if (tx) {
    chain = checkFinalizeTransfers(tx, {
      quoteMint: facts.quoteMint,
      cross: facts.cross,
      feeRecipient: facts.feeRecipient,
      integrator: facts.integrator,
      proceedsTo: facts.proceedsTo,
      protocolFee: recorded.protocolFee,
      integratorFee: recorded.integratorFee,
      proceedsQuote: recorded.proceedsQuote,
      referrer: referrer ?? undefined,
      referral,
    });
    if (!chain.ok) reasons.push(`chain: ${chain.reason}`);
  }
  const verdict: Verdict = reasons.length > 0 ? 'MISMATCH' : tx ? 'MATCH' : 'UNVERIFIED';
  return { facts, recorded, expected, referrer, referral, verdict, reasons, chain };
}

export type MintTotals = { protocolFee: bigint; integratorFee: bigint; referralFee: bigint; crosses: number };
export type Totals = Readonly<Record<string, MintTotals>>;

/**
 * Fee totals per quote mint over the entries that matched the chain. Mismatched and unverified entries are counted apart, never added in.
 * `protocolFee` is the gross protocol fee the event records; `referralFee` is the part of it that went to referrers, so the protocol's own take is the difference.
 */
export function totalsByMint(entries: readonly LedgerEntry[]): { readonly verified: Totals; readonly unverified: number; readonly mismatched: number } {
  const verified: Record<string, MintTotals> = {};
  let unverified = 0;
  let mismatched = 0;
  for (const e of entries) {
    if (e.verdict === 'UNVERIFIED') unverified++;
    else if (e.verdict === 'MISMATCH') mismatched++;
    else {
      const t = (verified[e.facts.quoteMint] ??= { protocolFee: 0n, integratorFee: 0n, referralFee: 0n, crosses: 0 });
      t.protocolFee += e.recorded.protocolFee;
      t.integratorFee += e.recorded.integratorFee;
      t.referralFee += e.referral;
      t.crosses += 1;
    }
  }
  return { verified, unverified, mismatched };
}
