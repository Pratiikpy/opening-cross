// Proving a ledger line against the chain. `finalize` moves the cross's quote vault into up to three places:
// the protocol fee recipient, the integrator and the proceeds recipient. This reads the transaction's own token
// balances and checks that each owner gained exactly what the ledger says, with the vault losing exactly the sum.
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
  readonly protocolFee: bigint;
  readonly integratorFee: bigint;
  readonly proceedsQuote: bigint;
};

export type TransferCheck =
  | { readonly ok: true; readonly observed: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string; readonly expected: Readonly<Record<string, string>>; readonly observed: Readonly<Record<string, string>> };

const text = (m: Map<string, bigint>): Record<string, string> => Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));

/** Compares the transaction's real balance changes with the fee split the ledger recorded for it. */
export function checkFinalizeTransfers(tx: TransactionBalances, r: FinalizeRoles): TransferCheck {
  const expected = new Map<string, bigint>();
  const credit = (owner: string, v: bigint) => expected.set(owner, (expected.get(owner) ?? 0n) + v);
  credit(r.feeRecipient, r.protocolFee);
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
