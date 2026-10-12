// The revenue ledger: one entry per finalized cross, built from three independent sources that must agree.
//   1. the cross account's own counters, run through the program's fee rules (`expected`),
//   2. the CrossFinalized event the indexer recorded (`recorded`),
//   3. the token balance changes of the finalize transaction itself (`chain`).
// An entry is MATCH only when all three agree to the atom. Anything else is MISMATCH with the reason; a ledger line
// that could not be checked against the chain is UNVERIFIED, never silently counted as verified.
import { type TransferCheck, type TransactionBalances, checkFinalizeTransfers } from './chain.js';
import { type CrossKind, type FeeSplit, type SupplyMode, expectedFinalizeFees } from './schedule.js';

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
  readonly expected: FeeSplit;
  readonly verdict: Verdict;
  /** Why the verdict is not MATCH. */
  readonly reasons: readonly string[];
  readonly chain: TransferCheck | null;
};

/** Builds one entry. `tx` is the finalize transaction's balances, or null when it could not be fetched. */
export function ledgerEntry(facts: CrossFeeFacts, recorded: RecordedFinalize, tx: TransactionBalances | null): LedgerEntry {
  const expected = expectedFinalizeFees({ supplyMode: facts.supplyMode, protocolBps: facts.protocolBps, integratorBps: facts.integratorBps, buyerPaid: facts.buyerPaid, feesAccrued: facts.feesAccrued });
  const reasons: string[] = [];
  if (expected.protocol !== recorded.protocolFee) reasons.push(`protocol fee: the cross's counters give ${expected.protocol}, the event recorded ${recorded.protocolFee}`);
  if (expected.integrator !== recorded.integratorFee) reasons.push(`integrator fee: the cross's counters give ${expected.integrator}, the event recorded ${recorded.integratorFee}`);
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
    });
    if (!chain.ok) reasons.push(`chain: ${chain.reason}`);
  }
  const verdict: Verdict = reasons.length > 0 ? 'MISMATCH' : tx ? 'MATCH' : 'UNVERIFIED';
  return { facts, recorded, expected, verdict, reasons, chain };
}

export type Totals = Readonly<Record<string, { protocolFee: bigint; integratorFee: bigint; crosses: number }>>;

/** Fee totals per quote mint over the entries that matched the chain. Mismatched and unverified entries are counted apart, never added in. */
export function totalsByMint(entries: readonly LedgerEntry[]): { readonly verified: Totals; readonly unverified: number; readonly mismatched: number } {
  const verified: Record<string, { protocolFee: bigint; integratorFee: bigint; crosses: number }> = {};
  let unverified = 0;
  let mismatched = 0;
  for (const e of entries) {
    if (e.verdict === 'UNVERIFIED') unverified++;
    else if (e.verdict === 'MISMATCH') mismatched++;
    else {
      const t = (verified[e.facts.quoteMint] ??= { protocolFee: 0n, integratorFee: 0n, crosses: 0 });
      t.protocolFee += e.recorded.protocolFee;
      t.integratorFee += e.recorded.integratorFee;
      t.crosses += 1;
    }
  }
  return { verified, unverified, mismatched };
}
