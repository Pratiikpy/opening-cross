// Signed statements. A statement is a period's worth of ledger lines for one party (an integrator's fee income, an
// issuer's fees paid, the protocol's revenue, a referrer's payouts), with a verdict per line and totals over the lines
// that matched the chain only. The billing service signs it with its own key so a party can hold a document they can
// check later and hand to an accountant: the signature covers a domain prefix and the hash of the canonical body.
import { type Address, address as toAddress, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';
import type { LedgerEntry, Verdict } from './ledger.js';
import type { ReferralLine } from './referral.js';

export const STATEMENT_SCHEMA = 'opening-cross/statement/v1';
export const STATEMENT_DOMAIN = 'opening-cross/statement/v1\n';

export type StatementRole = 'integrator' | 'issuer' | 'protocol' | 'referrer';

export type StatementLine = {
  /** The cross (or the order, for a referral line) the amount comes from. */
  readonly ref: string;
  /** The transaction that moved the money. */
  readonly signature: string;
  /** Unix seconds, or null if the node returned no block time. */
  readonly at: number | null;
  readonly quoteMint: string;
  /** Atoms, decimal string. */
  readonly amount: string;
  readonly verdict: Verdict;
};

export type StatementBody = {
  readonly schema: typeof STATEMENT_SCHEMA;
  readonly cluster: string;
  readonly role: StatementRole;
  readonly party: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly lines: readonly StatementLine[];
  /** Per quote mint, the sum over MATCH lines only. */
  readonly totals: Readonly<Record<string, string>>;
  readonly counts: { readonly match: number; readonly unverified: number; readonly mismatch: number };
};

export type SignedStatement = { readonly body: StatementBody; readonly id: string; readonly signer: string; readonly signature: string };

function assemble(cluster: string, role: StatementRole, party: string, periodStart: number, periodEnd: number, lines: StatementLine[]): StatementBody {
  const sorted = [...lines].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const totals: Record<string, bigint> = {};
  const counts = { match: 0, unverified: 0, mismatch: 0 };
  for (const l of sorted) {
    if (l.verdict === 'MATCH') {
      totals[l.quoteMint] = (totals[l.quoteMint] ?? 0n) + BigInt(l.amount);
      counts.match++;
    } else if (l.verdict === 'UNVERIFIED') counts.unverified++;
    else counts.mismatch++;
  }
  return { schema: STATEMENT_SCHEMA, cluster, role, party, periodStart, periodEnd, lines: sorted, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])), counts };
}

const inPeriod = (at: number | null, start: number, end: number): boolean => at !== null && at >= start && at < end;

/**
 * The statement a role receives from finalized crosses. Escrow-mode issuers pay no fee (their sellers do), so they have no line.
 *
 * A cross that names a referrer (ADR-0460) pays the referrer a share of the protocol fee out of that fee, so the roles read it as follows. The protocol
 * statement shows what the fee recipient was paid, the protocol fee less the referral. The integrator and issuer statements are unchanged: the referral
 * moves nothing on their side. The `referrer` role shows the referral each cross paid it, one line per cross; payouts of the earlier off-chain router
 * (`referrerStatement`) are per order and are a different basis, which `referrerStatementWithRouter` puts side by side.
 */
export function statementFromEntries(cluster: string, role: StatementRole, party: string, entries: readonly LedgerEntry[], periodStart: number, periodEnd: number): StatementBody {
  const lines: StatementLine[] = [];
  for (const e of entries) {
    if (!inPeriod(e.recorded.blockTime, periodStart, periodEnd)) continue;
    const f = e.facts;
    let amount: bigint | null = null;
    if (role === 'integrator' && f.integrator === party) amount = e.recorded.integratorFee;
    else if (role === 'protocol' && f.feeRecipient === party) amount = e.recorded.protocolFee - e.referral;
    else if (role === 'issuer' && f.creator === party && f.supplyMode !== 'escrow') amount = e.recorded.protocolFee + e.recorded.integratorFee;
    else if (role === 'referrer' && e.referrer === party && e.referral > 0n) amount = e.referral;
    if (amount === null) continue;
    lines.push({ ref: f.cross, signature: e.recorded.signature, at: e.recorded.blockTime, quoteMint: f.quoteMint, amount: amount.toString(), verdict: e.verdict });
  }
  return assemble(cluster, role, party, periodStart, periodEnd, lines);
}

/**
 * One referrer's statement over both ways a referrer is paid: the referral a cross pays at finalize (a line per cross, MATCH once the finalize transaction's
 * balances agree) and the per-order payouts of the off-chain router (a line per order, MATCH only once a transfer is recorded). The two never cover the same
 * cross: `referralLines` yields nothing for a cross that names a referrer on chain.
 */
export function referrerStatementWithRouter(
  cluster: string,
  party: string,
  entries: readonly LedgerEntry[],
  routerLines: readonly (ReferralLine & { readonly quoteMint: string; readonly at: number | null; readonly paidBy: string | null })[],
  periodStart: number,
  periodEnd: number,
): StatementBody {
  const onChain = statementFromEntries(cluster, 'referrer', party, entries, periodStart, periodEnd).lines;
  const router = referrerStatement(cluster, party, routerLines, periodStart, periodEnd).lines;
  return assemble(cluster, 'referrer', party, periodStart, periodEnd, [...onChain, ...router]);
}

/** A referrer's statement: payout lines, each with the transfer that paid it (`paidBy`), and verdict MATCH only once that transfer is confirmed. */
export function referrerStatement(cluster: string, party: string, lines: readonly (ReferralLine & { readonly quoteMint: string; readonly at: number | null; readonly paidBy: string | null })[], periodStart: number, periodEnd: number): StatementBody {
  const rows: StatementLine[] = lines
    .filter((l) => l.referrer === party && inPeriod(l.at, periodStart, periodEnd))
    .map((l) => ({ ref: l.order, signature: l.paidBy ?? '', at: l.at, quoteMint: l.quoteMint, amount: l.payout.toString(), verdict: l.paidBy ? ('MATCH' as const) : ('UNVERIFIED' as const) }));
  return assemble(cluster, 'referrer', party, periodStart, periodEnd, rows);
}

export const statementId = (b: StatementBody): string => hashJcs(b as unknown as Json);
const message = (id: string): Uint8Array => new TextEncoder().encode(STATEMENT_DOMAIN + id);

export async function signStatement(body: StatementBody, keyPair: CryptoKeyPair, signer: string): Promise<SignedStatement> {
  const id = statementId(body);
  return { body, id, signer, signature: bytesToHex(await signBytes(keyPair.privateKey, message(id))) };
}

export type StatementCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'MALFORMED' | 'WRONG_SIGNER' | 'TOTALS_MISMATCH' };

/** Checks the id, the signature, the expected signer, and that the totals are the sum of the MATCH lines. */
export async function verifyStatement(s: SignedStatement, expectedSigner?: string): Promise<StatementCheck> {
  if (expectedSigner !== undefined && s.signer !== expectedSigner) return { ok: false, reason: 'WRONG_SIGNER' };
  let id: string;
  try {
    id = statementId(s.body);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (id !== s.id) return { ok: false, reason: 'ID_MISMATCH' };
  const recomputed = assemble(s.body.cluster, s.body.role, s.body.party, s.body.periodStart, s.body.periodEnd, [...s.body.lines]);
  if (statementId(recomputed) !== s.id) return { ok: false, reason: 'TOTALS_MISMATCH' };
  if (!/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'MALFORMED' };
  try {
    const key = await getPublicKeyFromAddress(toAddress(s.signer) as Address);
    return (await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.id))) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}
