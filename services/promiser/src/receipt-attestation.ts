// A signed attestation of a shareable receipt (row S2, ADR-0941).
//
// The receipt itself (`opening-cross/receipt/v1|v2`, apps/web/src/lib/receipt.ts) is a recomputation bound to its content by a SHA-256 hash and carries no key and no clock, so the same cross
// always yields the same bytes. This document sits beside it and adds the two things the receipt says it lacks: a key that stands behind the hash, and a time that bounds when the hash
// existed. The receipt is not changed, so every receipt hash already shared stays what it was.
//
//   { body, id, signer, signature }       the shape of every document in @opening-cross/attest: `id` is the sha-256 of the canonical body, `signature` is Ed25519 over `schema + "\n" + id`
//
// The ids are folded into a Merkle root that a Memo transaction writes to the chain, exactly as promises are (packages/promises/src/digest.ts), under a different memo prefix so a
// promise digest can never be read as a receipt digest. The transaction's block time bounds the attestation from above; the Merkle proof ties the attestation to the root.
//
// What it attests, and no more: the signer fetched the receipt of this cross, found its bytes canonical, found its own record of the result (read from the cross account) equal to what the
// receipt states, and found the receipt's recomputation flag true. It does not re-run the clearing rule, and it is not a proof that the clearing is correct.
import { createHash } from 'node:crypto';
import { type KeyPairSigner, type SignatureBytes, address, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import { type Digest, type Json, hashJcs } from '@opening-cross/promises';

export const RECEIPT_ATTESTATION_SCHEMA = 'opening-cross/receipt-attestation/v1';
/** What a receipt digest writes to the chain. Distinct from the promise digest prefix. */
export const RECEIPT_MEMO_PREFIX = 'opening-cross/receipts/v1';
export const RECEIPT_SCHEMAS = ['opening-cross/receipt/v1', 'opening-cross/receipt/v2'] as const;
export const ATTESTED_STATES = ['Finalized', 'NoPrint'] as const;

/** Stated inside every attestation so the document cannot be quoted without it. */
export const ATTESTATION_STATEMENT =
  'The signer fetched the receipt with this hash for this cross, found its bytes canonical and its recorded result equal to the cross account on chain, and found its recomputation flag true. It attests the hash of the receipt, not that the clearing rule was applied correctly: that is for anyone to recompute.';

export interface ReceiptAttestationBody {
  readonly [k: string]: Json | undefined;
  readonly schema: typeof RECEIPT_ATTESTATION_SCHEMA;
  readonly cluster: string;
  readonly cross: string;
  readonly receiptSchema: (typeof RECEIPT_SCHEMAS)[number];
  /** The lowercase hex SHA-256 of the receipt's canonical bytes: the body of `/receipt/<cross>/json`. */
  readonly receiptSha256: string;
  readonly state: (typeof ATTESTED_STATES)[number];
  readonly statement: string;
}

export interface SignedReceiptAttestation {
  readonly body: ReceiptAttestationBody;
  readonly id: string;
  readonly signer: string;
  readonly signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export class ReceiptAttestationError extends Error {
  override readonly name = 'ReceiptAttestationError';
}

/** Throws for a body that could not be a faithful attestation. */
export function validateAttestationBody(b: ReceiptAttestationBody): void {
  if (b.schema !== RECEIPT_ATTESTATION_SCHEMA) throw new ReceiptAttestationError(`unknown schema ${String(b.schema)}`);
  if (b.cluster.trim() === '') throw new ReceiptAttestationError('cluster is empty');
  if (!BASE58.test(b.cross)) throw new ReceiptAttestationError('cross must be a base58 Solana address');
  if (!(RECEIPT_SCHEMAS as readonly string[]).includes(b.receiptSchema)) throw new ReceiptAttestationError(`unknown receipt schema ${String(b.receiptSchema)}`);
  if (!HEX64.test(b.receiptSha256)) throw new ReceiptAttestationError('receiptSha256 must be 64 lowercase hex characters');
  if (!(ATTESTED_STATES as readonly string[]).includes(b.state)) throw new ReceiptAttestationError(`a receipt is attested only once its cross is ${ATTESTED_STATES.join(' or ')}, not ${String(b.state)}`);
  if (b.statement !== ATTESTATION_STATEMENT) throw new ReceiptAttestationError('statement must be the standard statement');
}

export const attestationId = (b: ReceiptAttestationBody): string => {
  validateAttestationBody(b);
  return hashJcs(b);
};

const message = (b: ReceiptAttestationBody, id: string): Uint8Array => new TextEncoder().encode(`${b.schema}\n${id}`);

export function attestationBody(i: { cluster: string; cross: string; receiptSchema: ReceiptAttestationBody['receiptSchema']; receiptSha256: string; state: ReceiptAttestationBody['state'] }): ReceiptAttestationBody {
  const body: ReceiptAttestationBody = { schema: RECEIPT_ATTESTATION_SCHEMA, ...i, statement: ATTESTATION_STATEMENT };
  validateAttestationBody(body);
  return body;
}

export async function signReceiptAttestation(body: ReceiptAttestationBody, signer: KeyPairSigner): Promise<SignedReceiptAttestation> {
  const id = attestationId(body);
  return { body, id, signer: signer.address, signature: hex(await signBytes(signer.keyPair.privateKey, message(body, id))) };
}

export type AttestationCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'MALFORMED' | 'ID_MISMATCH' | 'WRONG_SIGNER' | 'BAD_SIGNATURE' };

/** Checks the id against the body and the signature against the signer, and (optionally) the signer against the published one. */
export async function verifyReceiptAttestation(s: SignedReceiptAttestation, expectedSigner?: string): Promise<AttestationCheck> {
  let id: string;
  try {
    id = attestationId(s.body);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (id !== s.id) return { ok: false, reason: 'ID_MISMATCH' };
  if (expectedSigner !== undefined && s.signer !== expectedSigner) return { ok: false, reason: 'WRONG_SIGNER' };
  if (!/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'BAD_SIGNATURE' };
  try {
    const key = await getPublicKeyFromAddress(address(s.signer));
    const ok = await verifySignature(key, Uint8Array.from(Buffer.from(s.signature, 'hex')) as SignatureBytes, message(s.body, s.id));
    return ok ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
}

// ------------------------------------------------------------------------------------------------ the chain anchor

export const receiptMemoText = (d: Digest): string => `${RECEIPT_MEMO_PREFIX} root=${d.root} n=${d.count}`;

export function parseReceiptMemo(text: string): Digest | null {
  const m = /^opening-cross\/receipts\/v1 root=([0-9a-f]{64}) n=(\d+)$/.exec(text);
  return m ? { root: m[1] as string, count: Number(m[2]) } : null;
}

// ------------------------------------------------------------------------------------------------ the receipt bytes

/**
 * Canonical JSON exactly as the web app writes a receipt (apps/web/src/lib/receipt.ts `canonicalJson`): keys sorted at every level, no whitespace, standard string escapes, `undefined` omitted,
 * non-finite numbers refused. It is not the promise canonicaliser, because a receipt may carry a non-integer number (the allocation's `rho`).
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new ReceiptAttestationError('a number in a receipt must be finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
