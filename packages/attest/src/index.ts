// Signed documents. Every attestation Opening Cross issues from a service key (a verification receipt, an audit bundle, an
// alert, an ops-log head) has the same shape:
//
//   { body, id, signer, signature }
//
// `body` is canonical JSON (RFC 8785 subset: integers and strings only), `id` is the sha-256 of that canonical form, and
// `signature` is an Ed25519 signature by `signer` over `domain + id`. The domain is the body's own `schema` string followed
// by a newline, so a signature made for one kind of document can never be accepted as another.
//
// The signer is a published key. A reader checks the signature, then checks the key against the one the operator publishes
// (`/v1/attestations/signer`); a signature by an unknown key proves only that somebody holds that key.
import { type Address, address as toAddress, createKeyPairFromBytes, getAddressFromPublicKey, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';

export type AttestedBody = { readonly schema: string; readonly [k: string]: Json | undefined };

export type Signed<B extends AttestedBody> = { readonly body: B; readonly id: string; readonly signer: string; readonly signature: string };

export class AttestError extends Error {
  override readonly name = 'AttestError';
}

const SCHEMA = /^opening-cross\/[a-z0-9-]+\/v[0-9]+$/;

function domainOf(body: AttestedBody): string {
  if (typeof body.schema !== 'string' || !SCHEMA.test(body.schema)) throw new AttestError(`schema must look like "opening-cross/<name>/v<number>", got ${JSON.stringify(body.schema)}`);
  return `${body.schema}\n`;
}

export const documentId = (body: AttestedBody): string => {
  domainOf(body);
  return hashJcs(body as unknown as Json);
};

const message = (body: AttestedBody, id: string): Uint8Array => new TextEncoder().encode(domainOf(body) + id);

export async function signDocument<B extends AttestedBody>(body: B, keyPair: CryptoKeyPair): Promise<Signed<B>> {
  const id = documentId(body);
  const signer = await getAddressFromPublicKey(keyPair.publicKey);
  return { body, id, signer, signature: bytesToHex(await signBytes(keyPair.privateKey, message(body, id))) };
}

export type DocumentCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'MALFORMED' | 'ID_MISMATCH' | 'WRONG_SIGNER' | 'BAD_SIGNATURE' };

/** Checks id and signature; pass `expectedSigner` to also require the published key. */
export async function verifyDocument<B extends AttestedBody>(s: Signed<B>, expectedSigner?: string): Promise<DocumentCheck> {
  let id: string;
  try {
    id = documentId(s.body);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (id !== s.id) return { ok: false, reason: 'ID_MISMATCH' };
  if (expectedSigner !== undefined && s.signer !== expectedSigner) return { ok: false, reason: 'WRONG_SIGNER' };
  if (!/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'BAD_SIGNATURE' };
  try {
    const key = await getPublicKeyFromAddress(toAddress(s.signer) as Address);
    return (await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.body, s.id))) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
}

/** Reads a Solana CLI keypair (a JSON array of 64 bytes) into a CryptoKeyPair that can sign. Never logs or returns the bytes. */
export async function keyPairFromSolanaFile(text: string): Promise<{ keyPair: CryptoKeyPair; address: string }> {
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new AttestError('a keypair file must be a JSON array of 64 bytes');
  const bytes = Uint8Array.from(arr as number[]);
  const keyPair = await createKeyPairFromBytes(bytes);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

/** sha-256 of a JSON value in canonical form, hex: the same function receipt-v1 uses for `proofSha256`. */
export const canonicalSha256 = (v: Json): string => hashJcs(v);
