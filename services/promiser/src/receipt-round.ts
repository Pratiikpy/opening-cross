// The promiser's receipt rounds (row S2, ADR-0941). Like the promise rounds they are plain functions of their dependencies, so the tests drive the real code with a controllable chain and
// receipt source, and the process only wires in the real ones.
//
//   attestRound         for every cross that has settled for good and has no attestation, fetch its receipt, check it against the cross account, and sign its hash.
//   anchorReceiptsRound fold the attestation ids not yet anchored into a Merkle root and write it to the chain in a Memo transaction.
import type { Address, KeyPairSigner } from '@solana/kit';
import { type Cross, CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';
import { merkleRoot } from '@opening-cross/promises';
import type { AccountReader } from '@opening-cross/router';
import {
  ATTESTED_STATES,
  RECEIPT_SCHEMAS,
  type ReceiptAttestationBody,
  attestationBody,
  canonicalJson,
  receiptMemoText,
  sha256Hex,
  signReceiptAttestation,
} from './receipt-attestation.js';
import { type Queryable, crossesToAttest, crossesToRecheck, insertAttestation, latestReceiptHash, markChecked, recordReceiptAnchor, unanchoredAttestationIds } from './receipt-store.js';

/** What the receipt source answers for one cross: the HTTP status, the body, and the `x-receipt-sha256` header the web app sends. */
export interface ReceiptFetch {
  readonly status: number;
  readonly text: string;
  readonly sha256: string | null;
}

export interface ReceiptDeps {
  readonly db: Queryable;
  readonly cluster: string;
  readonly signer: KeyPairSigner;
  /** Reads an account from the cluster, as the promise rounds do. */
  readonly read: AccountReader;
  /** The bytes served at `/receipt/<cross>/json` by the web app. */
  readonly fetchReceipt: (cross: string) => Promise<ReceiptFetch>;
  /** Cluster time, unix seconds. */
  readonly now: () => Promise<number>;
  /** Crosses handled in one round. Default 20. */
  readonly perRound?: number;
  /** An attested receipt is fetched again after this many seconds, in case the bytes served for it changed. Default six hours. */
  readonly recheckAfterSeconds?: number;
}

export type SkipReason =
  | 'NOT_SETTLED'
  | 'NO_SUCH_CROSS'
  | 'UNSUPPORTED_PROOF'
  | 'UNAVAILABLE'
  | 'MALFORMED'
  | 'NOT_CANONICAL'
  | 'HASH_MISMATCH'
  | 'NETWORK_MISMATCH'
  | 'NOT_FINAL'
  | 'RECOMPUTATION_DID_NOT_MATCH'
  | 'NOT_ON_CHAIN'
  | 'CHAIN_DISAGREES';

export interface AttestReport {
  /** Crosses that got their first attestation. */
  readonly attested: string[];
  /** Crosses whose served receipt changed after it was attested: a second attestation was added for the new hash. */
  readonly changed: string[];
  /** Crosses fetched again whose receipt is the one already attested. */
  readonly unchanged: number;
  readonly skipped: { readonly cross: string; readonly reason: SkipReason; readonly detail?: string }[];
}

const RATIONED = ['none', 'buy', 'sell'] as const;

async function readCross(read: AccountReader, address: string): Promise<Cross | null> {
  const a = await read(address as Address);
  return a ? getCrossDecoder().decode(a.data) : null;
}

type Receipt = {
  schema: string;
  network: string;
  cross: string;
  result: { state: string; printed: boolean; price: string | null; matched: string | null; rationed: string | null };
  verification: { recomputedMatchesChain: boolean };
  wallet: unknown;
};

/** Where the receipt's recorded result and the cross account differ, as a sentence; null when they agree. */
function disagreement(r: Receipt, c: Cross): string | null {
  if (CrossState[c.state] !== r.result.state) return `the receipt says ${r.result.state}, the cross account says ${CrossState[c.state]}`;
  if (c.clearing.__option === 'None') return r.result.printed ? 'the receipt says the cross printed, the account has no clearing' : null;
  const k = c.clearing.value;
  if (!r.result.printed) return 'the receipt says the cross did not print, the account has a clearing';
  if (r.result.price !== k.price.toString()) return `the receipt says price ${String(r.result.price)}, the account says ${k.price}`;
  if (r.result.matched !== k.matched.toString()) return `the receipt says matched ${String(r.result.matched)}, the account says ${k.matched}`;
  if (r.result.rationed !== (RATIONED[k.rationed] ?? null)) return `the receipt says rationed ${String(r.result.rationed)}, the account says ${RATIONED[k.rationed] ?? k.rationed}`;
  return null;
}

type One = { kind: 'attested' } | { kind: 'changed' } | { kind: 'unchanged' } | { kind: 'skipped'; reason: SkipReason; detail?: string };

async function attestOne(d: ReceiptDeps, cross: string, now: number): Promise<One> {
  const skip = (reason: SkipReason, detail?: string): One => ({ kind: 'skipped', reason, ...(detail !== undefined && { detail }) });
  let f: ReceiptFetch;
  try {
    f = await d.fetchReceipt(cross);
  } catch (e) {
    return skip('UNAVAILABLE', String(e));
  }
  if (f.status === 409) return skip('NOT_SETTLED');
  if (f.status === 404) return skip('NO_SUCH_CROSS');
  if (f.status === 422) return skip('UNSUPPORTED_PROOF');
  if (f.status !== 200) return skip('UNAVAILABLE', `the receipt source answered ${f.status}`);

  let receipt: Receipt;
  try {
    receipt = JSON.parse(f.text) as Receipt;
    if (canonicalJson(receipt) !== f.text) return skip('NOT_CANONICAL');
  } catch (e) {
    return skip('MALFORMED', String(e));
  }
  const hash = sha256Hex(f.text);
  if (f.sha256 !== null && f.sha256 !== hash) return skip('HASH_MISMATCH', `served header ${f.sha256}, computed ${hash}`);
  if (!(RECEIPT_SCHEMAS as readonly string[]).includes(receipt.schema) || receipt.cross !== cross || receipt.wallet !== null || typeof receipt.result !== 'object' || receipt.result === null) return skip('MALFORMED', 'not the receipt of this cross');
  if (receipt.network !== d.cluster) return skip('NETWORK_MISMATCH', `the receipt is for ${receipt.network}, this promiser follows ${d.cluster}`);
  if (!(ATTESTED_STATES as readonly string[]).includes(receipt.result.state)) return skip('NOT_FINAL', receipt.result.state);
  if (receipt.verification?.recomputedMatchesChain !== true) return skip('RECOMPUTATION_DID_NOT_MATCH');

  const c = await readCross(d.read, cross);
  if (!c) return skip('NOT_ON_CHAIN');
  const why = disagreement(receipt, c);
  if (why) return skip('CHAIN_DISAGREES', why);

  const had = await latestReceiptHash(d.db, d.cluster, cross);
  if (had === hash) {
    await markChecked(d.db, d.cluster, cross, now);
    return { kind: 'unchanged' };
  }
  const body: ReceiptAttestationBody = attestationBody({ cluster: d.cluster, cross, receiptSchema: receipt.schema as ReceiptAttestationBody['receiptSchema'], receiptSha256: hash, state: receipt.result.state as ReceiptAttestationBody['state'] });
  await insertAttestation(d.db, d.cluster, await signReceiptAttestation(body, d.signer), now);
  return { kind: had === null ? 'attested' : 'changed' };
}

/** A cross that could not be attested is not tried again at once: it would take the place of crosses that can be, round after round. A transient reason is retried soon, a verdict about the receipt much later. */
const RETRY_SECONDS: Record<SkipReason, number> = {
  NOT_SETTLED: 120,
  NO_SUCH_CROSS: 120,
  UNAVAILABLE: 120,
  UNSUPPORTED_PROOF: 3600,
  MALFORMED: 3600,
  NOT_CANONICAL: 3600,
  HASH_MISMATCH: 600,
  NETWORK_MISMATCH: 3600,
  NOT_FINAL: 600,
  RECOMPUTATION_DID_NOT_MATCH: 3600,
  NOT_ON_CHAIN: 600,
  CHAIN_DISAGREES: 3600,
};
const waiting = new WeakMap<object, Map<string, number>>();

export async function attestRound(d: ReceiptDeps): Promise<AttestReport> {
  const now = await d.now();
  const perRound = d.perRound ?? 20;
  const report = { attested: [] as string[], changed: [] as string[], unchanged: 0, skipped: [] as AttestReport['skipped'][number][] };
  const retryAt = waiting.get(d) ?? new Map<string, number>();
  waiting.set(d, retryAt);
  for (const [cross, at] of retryAt) if (at <= now) retryAt.delete(cross);
  const fresh = await crossesToAttest(d.db, d.cluster, perRound, [...retryAt.keys()]);
  const recheck = fresh.length < perRound ? await crossesToRecheck(d.db, d.cluster, now - (d.recheckAfterSeconds ?? 21_600), perRound - fresh.length) : [];
  for (const cross of [...fresh, ...recheck.filter((c) => !retryAt.has(c))]) {
    const r = await attestOne(d, cross, now);
    if (r.kind === 'attested') report.attested.push(cross);
    else if (r.kind === 'changed') report.changed.push(cross);
    else if (r.kind === 'unchanged') report.unchanged += 1;
    else {
      retryAt.set(cross, now + RETRY_SECONDS[r.reason]);
      report.skipped.push({ cross, reason: r.reason, ...(r.detail !== undefined && { detail: r.detail }) });
    }
  }
  return report;
}

export interface ReceiptAnchorReport {
  readonly anchored: number;
  readonly signature: string | null;
}

/** `send` writes the memo and returns the transaction's signature, slot and block time. */
export async function anchorReceiptsRound(d: Pick<ReceiptDeps, 'db' | 'cluster'>, send: (memo: string) => Promise<{ signature: string; slot: number | null; blockTime: number | null }>): Promise<ReceiptAnchorReport> {
  const ids = await unanchoredAttestationIds(d.db, d.cluster);
  if (ids.length === 0) return { anchored: 0, signature: null };
  const digest = { root: merkleRoot(ids), count: new Set(ids).size };
  const tx = await send(receiptMemoText(digest));
  await recordReceiptAnchor(d.db, d.cluster, digest, ids, tx);
  return { anchored: digest.count, signature: tx.signature };
}
