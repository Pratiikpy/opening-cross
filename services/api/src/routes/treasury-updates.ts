// Treasury disclosure updates (PRODUCT_FEATURES E5): the treasury owner signs a periodic update, anchors its id in a Memo
// transaction signed by the same key, and the API stores it. The signing and anchoring pattern is the promiser's
// (packages/promises): the id is the sha-256 of the RFC 8785 canonical body, the signature covers the id under a domain prefix,
// and a chain transaction bounds the update in time. Here the "root" is a single update id rather than a Merkle root, and the
// Memo must be signed by the treasury authority, so the chain itself says who anchored it.
//
// What this proves and what it does not: that the authority of the treasury, as the chain records it, said exactly this at or
// before the memo's block time, and that it chains to the previous update. It does not prove the content is true. The only
// figure that can be checked against the chain is `declaredSpentAtoms`, which the API compares with the program's Spent events.
import { getPublicKeyFromAddress, signBytes, verifySignature, address as toAddress } from '@solana/kit';
import type { KeyPairSigner, SignatureBytes } from '@solana/kit';
import { type Json, hashJcs } from '@opening-cross/promises';

export const UPDATE_SCHEMA = 'opening-cross/treasury-update/v1';
export const UPDATE_SIGNING_DOMAIN = `${UPDATE_SCHEMA}\n`;
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TITLE_MAX = 120;
export const SUMMARY_MAX = 4000;
/** The memo's block time may precede `issuedAt` by at most this much (the owner's clock against the cluster's). */
export const CLOCK_SKEW_SECONDS = 120;

export class UpdateError extends Error {
  override readonly name = 'UpdateError';
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type UpdateBody = {
  schema: typeof UPDATE_SCHEMA;
  cluster: string;
  treasury: string;
  authority: string;
  /** 1 for the first update; each is the previous plus one. */
  sequence: number;
  /** Id of the update with sequence - 1; null for the first. A chain, so a removed update is a visible gap. */
  previousId: string | null;
  /** Unix seconds when the owner signed. */
  issuedAt: number;
  /** The span the update reports on, unix seconds. */
  coveredFrom: number;
  coveredTo: number;
  title: string;
  summary: string;
  /** Quote atoms the owner says were spent in the covered span (decimal string), or null when no figure is given. */
  declaredSpentAtoms: string | null;
};

export type SignedUpdate = { id: string; body: UpdateBody; signer: string; signature: string };

const HEX64 = /^[0-9a-f]{64}$/;
const UINT = /^\d{1,20}$/;

/** Throws UpdateError for a body that is not a well-formed update. Does not check it against any chain state. */
export function validateBody(b: UpdateBody): void {
  if (b.schema !== UPDATE_SCHEMA) throw new UpdateError(`schema must be ${UPDATE_SCHEMA}`);
  for (const k of ['cluster', 'treasury', 'authority', 'title', 'summary'] as const) if (typeof b[k] !== 'string') throw new UpdateError(`${k} must be a string`);
  if (b.cluster.trim() === '') throw new UpdateError('cluster is empty');
  const int = (v: unknown, f: string, min: number) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new UpdateError(`${f} must be an integer of at least ${min}`);
  };
  int(b.sequence, 'sequence', 1);
  int(b.issuedAt, 'issuedAt', 0);
  int(b.coveredFrom, 'coveredFrom', 0);
  int(b.coveredTo, 'coveredTo', 0);
  if (b.coveredFrom > b.coveredTo) throw new UpdateError('coveredFrom must not be after coveredTo');
  if (b.coveredTo > b.issuedAt) throw new UpdateError('an update cannot cover time after it was signed');
  if (b.sequence === 1 ? b.previousId !== null : typeof b.previousId !== 'string' || !HEX64.test(b.previousId)) throw new UpdateError('previousId must be null for sequence 1 and the previous update id (64 lowercase hex) after');
  if (b.title.trim() === '' || b.title.length > TITLE_MAX) throw new UpdateError(`title must be 1 to ${TITLE_MAX} characters`);
  if (b.summary.trim() === '' || b.summary.length > SUMMARY_MAX) throw new UpdateError(`summary must be 1 to ${SUMMARY_MAX} characters`);
  if (b.declaredSpentAtoms !== null && (typeof b.declaredSpentAtoms !== 'string' || !UINT.test(b.declaredSpentAtoms))) throw new UpdateError('declaredSpentAtoms must be null or a decimal string of quote atoms');
}

export function updateId(body: UpdateBody): string {
  validateBody(body);
  return hashJcs(body as unknown as Json);
}

const message = (id: string): Uint8Array => new TextEncoder().encode(UPDATE_SIGNING_DOMAIN + id);

/** Signs with the authority's keypair; the result is what the CLI posts. */
export async function signUpdate(body: UpdateBody, signer: KeyPairSigner): Promise<SignedUpdate> {
  if (signer.address !== body.authority) throw new UpdateError('the signing key is not the authority named in the body');
  const id = updateId(body);
  return { id, body, signer: signer.address, signature: Buffer.from(await signBytes(signer.keyPair.privateKey, message(id))).toString('hex') };
}

/** Id against body, then signature against signer. Does not check that the signer is the treasury's authority. */
export async function verifyUpdate(s: SignedUpdate): Promise<{ ok: true } | { ok: false; reason: 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'MALFORMED' | 'WRONG_SIGNER' }> {
  let id: string;
  try {
    id = updateId(s.body);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (id !== s.id) return { ok: false, reason: 'ID_MISMATCH' };
  if (s.signer !== s.body.authority) return { ok: false, reason: 'WRONG_SIGNER' };
  if (typeof s.signature !== 'string' || !/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'MALFORMED' };
  try {
    const key = await getPublicKeyFromAddress(toAddress(s.signer));
    return (await verifySignature(key, Uint8Array.from(Buffer.from(s.signature, 'hex')) as SignatureBytes, message(id))) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

export const memoTextOf = (treasury: string, sequence: number, id: string): string => `${UPDATE_SCHEMA} treasury=${treasury} seq=${sequence} id=${id}`;

export function parseMemo(text: string): { treasury: string; sequence: number; id: string } | null {
  const m = /^opening-cross\/treasury-update\/v1 treasury=([1-9A-HJ-NP-Za-km-z]{32,44}) seq=(\d+) id=([0-9a-f]{64})$/.exec(text);
  return m ? { treasury: m[1] as string, sequence: Number(m[2]), id: m[3] as string } : null;
}

/** The part of a `getTransaction` (jsonParsed) result the anchor check reads. */
export type MemoTx = {
  slot: number | bigint;
  blockTime: number | bigint | null;
  meta: { err: unknown } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: { programId: string; program?: string; parsed?: unknown }[];
    };
  };
};

/** Checks that `tx` is a successful transaction carrying exactly `expected` as a Memo, signed by `authority`; returns its slot and block time. */
export function checkAnchor(tx: MemoTx | null, expected: string, authority: string): { slot: number; blockTime: number } {
  if (!tx) throw new UpdateError('the memo transaction was not found on the cluster', 422);
  if (tx.meta?.err) throw new UpdateError('the memo transaction failed on chain', 422);
  if (tx.blockTime === null || tx.blockTime === undefined) throw new UpdateError('the memo transaction has no block time', 422);
  const m = tx.transaction.message;
  if (!m.instructions.some((i) => i.programId === MEMO_PROGRAM && i.parsed === expected)) throw new UpdateError('the transaction carries no Memo with the text this update requires', 422);
  if (!m.accountKeys.some((k) => k.signer && k.pubkey === authority)) throw new UpdateError('the memo transaction was not signed by the treasury authority', 422);
  return { slot: Number(tx.slot), blockTime: Number(tx.blockTime) };
}

// ---- when an update is due

export type DisclosureState = 'current' | 'requested' | 'overdue' | 'closed' | 'unknown';

export type Disclosure = {
  state: DisclosureState;
  /** What the clock runs from: the latest anchored update, or the treasury's creation if there is none. */
  basis: 'last-update' | 'creation' | null;
  basisAt: number | null;
  /** From this time an update is expected (basis + the allowance period). */
  requestedAt: number | null;
  /** From this time, with none posted, the update is overdue (requestedAt + the treasury's grace period). */
  overdueAt: number | null;
  updateCount: number;
  note: string;
};

/**
 * The reporting clock. This is a convention of the disclosure feed, not a rule of the program: an update is expected once per
 * allowance period (`period_secs`, on chain) and is overdue after a further `grace_secs` (on chain) without one. The program's
 * own consequence of silence is separate and unchanged: the auditor's attestation lapsing.
 */
export function disclosureState(i: { now: number; createdAt: number | null; periodSecs: number; graceSecs: number; liquidating: boolean; lastAnchoredAt: number | null; updateCount: number }): Disclosure {
  const base = { updateCount: i.updateCount };
  if (i.liquidating) return { ...base, state: 'closed', basis: null, basisAt: null, requestedAt: null, overdueAt: null, note: 'The treasury is in liquidation; no further updates are expected.' };
  const basisAt = i.lastAnchoredAt ?? i.createdAt;
  if (basisAt === null) return { ...base, state: 'unknown', basis: null, basisAt: null, requestedAt: null, overdueAt: null, note: 'The creation time of this treasury is not indexed yet, so the reporting clock cannot be computed.' };
  const requestedAt = basisAt + i.periodSecs;
  const overdueAt = requestedAt + i.graceSecs;
  const state: DisclosureState = i.now < requestedAt ? 'current' : i.now < overdueAt ? 'requested' : 'overdue';
  const note =
    state === 'current'
      ? i.lastAnchoredAt === null
        ? 'No update has been posted yet; the first is expected one period after creation.'
        : 'The latest update is within one allowance period.'
      : state === 'requested'
        ? 'An update is now expected: a full allowance period has passed since the last one.'
        : 'No update was posted within the period plus the grace period.';
  return { ...base, state, basis: i.lastAnchoredAt === null ? 'creation' : 'last-update', basisAt, requestedAt, overdueAt, note };
}
