// Proving a ledger line against the chain. `finalize` moves the cross's quote vault into up to four places:
// the protocol fee recipient, the integrator, the proceeds recipient and, when the cross names one, the referrer
// (ADR-0460: a share of the protocol fee, paid out of it). This reads the transaction's own token balances and checks
// that each owner gained exactly what the ledger says, with the vault losing exactly the sum.
// Roles that share an owner (one wallet can be issuer, integrator and fee recipient) are checked in aggregate.

/** The part of a `jsonParsed` token balance entry this check needs. */
export type TokenBalance = {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string | undefined;
  readonly uiTokenAmount: { readonly amount: string };
};

export type TransactionBalances = {
  readonly preTokenBalances: readonly TokenBalance[];
  readonly postTokenBalances: readonly TokenBalance[];
  /** Null when the transaction succeeded. */
  readonly err: unknown;
};

/** Net change of each owner's holding of `mint`, summed over that owner's token accounts. */
export function ownerDeltas(tx: TransactionBalances, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (b: TokenBalance, sign: 1n | -1n) => {
    if (b.mint !== mint || !b.owner) return;
    out.set(b.owner, (out.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  tx.preTokenBalances.forEach((b) => add(b, -1n));
  tx.postTokenBalances.forEach((b) => add(b, 1n));
  return out;
}

export type FinalizeRoles = {
  readonly quoteMint: string;
  /** The cross PDA: owner of the quote vault. */
  readonly cross: string;
  readonly feeRecipient: string;
  readonly integrator: string;
  readonly proceedsTo: string;
  /** The gross protocol fee, as the `CrossFinalized` event records it: the referral is part of it, not on top. */
  readonly protocolFee: bigint;
  readonly integratorFee: bigint;
  readonly proceedsQuote: bigint;
  /** The cross's referrer and the part of the protocol fee `finalize` paid it. Both absent (or a zero amount) when the cross names none. */
  readonly referrer?: string | undefined;
  readonly referral?: bigint | undefined;
};

export type TransferCheck =
  | { readonly ok: true; readonly observed: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string; readonly expected: Readonly<Record<string, string>>; readonly observed: Readonly<Record<string, string>> };

const text = (m: Map<string, bigint>): Record<string, string> => Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));

/** Compares the transaction's real balance changes with the fee split the ledger recorded for it. */
export function checkFinalizeTransfers(tx: TransactionBalances, r: FinalizeRoles): TransferCheck {
  const expected = new Map<string, bigint>();
  const credit = (owner: string, v: bigint) => expected.set(owner, (expected.get(owner) ?? 0n) + v);
  const referral = r.referral ?? 0n;
  if (referral < 0n || referral > r.protocolFee) return { ok: false, reason: `the referral ${referral} is not part of the protocol fee ${r.protocolFee}`, expected: {}, observed: text(ownerDeltas(tx, r.quoteMint)) };
  if (referral > 0n && !r.referrer) return { ok: false, reason: 'a referral was recorded but the cross names no referrer', expected: {}, observed: text(ownerDeltas(tx, r.quoteMint)) };
  credit(r.feeRecipient, r.protocolFee - referral);
  if (referral > 0n) credit(r.referrer as string, referral);
  credit(r.integrator, r.integratorFee);
  credit(r.proceedsTo, r.proceedsQuote);
  credit(r.cross, -(r.protocolFee + r.integratorFee + r.proceedsQuote));
  const observed = ownerDeltas(tx, r.quoteMint);
  if (tx.err !== null && tx.err !== undefined) return { ok: false, reason: 'the transaction failed', expected: text(expected), observed: text(observed) };
  for (const owner of new Set([...expected.keys(), ...observed.keys()])) {
    if ((expected.get(owner) ?? 0n) !== (observed.get(owner) ?? 0n)) {
      return { ok: false, reason: `${owner} changed by ${observed.get(owner) ?? 0n}, the ledger expects ${expected.get(owner) ?? 0n}`, expected: text(expected), observed: text(observed) };
    }
  }
  return { ok: true, observed: text(observed) };
}
