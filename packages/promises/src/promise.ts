// Building, hashing, signing and verifying promises. The id is the sha-256 of the canonical body, so
// altering a single byte after issuance changes the id; the signature covers the id under a domain
// prefix, so it binds the signer to exactly that body and nothing else.
import { type Address, type KeyPairSigner, getPublicKeyFromAddress, signBytes, verifySignature, address as toAddress } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from './jcs.js';
import { type OpeningCrossPromise, PROMISE_KINDS, PROMISE_SCHEMA, type PromiseBody, SIGNING_DOMAIN, type SignedPromise } from './types.js';

export class PromiseError extends Error {
  override readonly name = 'PromiseError';
}

const HEX64 = /^[0-9a-f]{64}$/;
const UINT = /^\d{1,20}$/;

/** Throws PromiseError for a body that could not be graded as written. */
export function validateBody(b: PromiseBody): void {
  if (b.schema !== PROMISE_SCHEMA) throw new PromiseError(`unknown schema ${String(b.schema)}`);
  if (!(PROMISE_KINDS as readonly string[]).includes(b.kind)) throw new PromiseError(`unknown kind ${String(b.kind)}`);
  if (b.cluster.trim() === '') throw new PromiseError('cluster is empty');
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) throw new PromiseError('issuedAt must be a non-negative integer');
  if (!Number.isSafeInteger(b.deadline) || b.deadline < b.issuedAt) throw new PromiseError('deadline must not precede issuedAt');
  const g = b.subject.grid;
  if (!UINT.test(g.minPrice) || !UINT.test(g.tick) || !UINT.test(g.priceScale) || BigInt(g.tick) === 0n) throw new PromiseError('grid prices must be positive integers');
  if (!Number.isInteger(g.ticks) || g.ticks < 2) throw new PromiseError('grid needs at least two ticks');
  if (!Number.isInteger(b.subject.bucket) || b.subject.bucket < 0) throw new PromiseError('bucket must be a non-negative integer');
  const c = b.claim;
  const inGrid = (t: number) => Number.isInteger(t) && t >= 0 && t < g.ticks;
  if (!inGrid(c.pointTick) || !inGrid(c.loTick) || !inGrid(c.hiTick)) throw new PromiseError('claim ticks must lie on the grid');
  if (!(c.loTick <= c.pointTick && c.pointTick <= c.hiTick)) throw new PromiseError('claim must satisfy lo ≤ point ≤ hi');
  if (c.status === 'CALIBRATED') {
    if (c.nominalCoverageBps === null || !(c.nominalCoverageBps > 0 && c.nominalCoverageBps < 10_000)) throw new PromiseError('a calibrated band claims a coverage strictly between 0 and 100%');
    if (c.calibration.quantileTicks === null) throw new PromiseError('a calibrated band needs a quantile');
    if (c.reason !== null) throw new PromiseError('a calibrated band has no provisional reason');
  } else if (c.status === 'PROVISIONAL') {
    if (c.nominalCoverageBps !== null) throw new PromiseError('a provisional band claims no coverage');
    if (c.reason === null || c.reason.trim() === '') throw new PromiseError('a provisional band says why');
  } else {
    throw new PromiseError(`unknown status ${String(c.status)}`);
  }
  if (!HEX64.test(b.inputsHash) || !HEX64.test(b.policyHash) || !HEX64.test(c.calibration.samplesHash)) throw new PromiseError('hashes are 64 lowercase hex characters');
  if (b.modelId.trim() === '') throw new PromiseError('modelId is empty');
}

export function promiseId(body: PromiseBody): string {
  validateBody(body);
  return hashJcs(body as unknown as Json);
}

/** Validate, hash and return the promise with its id. */
export function buildPromise(body: PromiseBody): OpeningCrossPromise {
  return { ...body, id: promiseId(body) };
}

/** Recompute the id from the body; a mismatch means the promise was altered after issuance. */
export function verifyPromiseId(p: OpeningCrossPromise): boolean {
  const { id, ...body } = p;
  try {
    return promiseId(body) === id;
  } catch {
    return false;
  }
}

const message = (id: string): Uint8Array => new TextEncoder().encode(SIGNING_DOMAIN + id);

/** Signs a promise with a Solana keypair signer's key. */
export async function signPromise(promise: OpeningCrossPromise, keyPair: CryptoKeyPair, signer: Address): Promise<SignedPromise> {
  if (!verifyPromiseId(promise)) throw new PromiseError('refusing to sign a promise whose id does not match its body');
  const sig = await signBytes(keyPair.privateKey, message(promise.id));
  return { promise, signer, signature: bytesToHex(sig) };
}

export async function signPromiseWith(promise: OpeningCrossPromise, signer: KeyPairSigner): Promise<SignedPromise> {
  return signPromise(promise, signer.keyPair, signer.address);
}

export type Verification = { readonly ok: true } | { readonly ok: false; readonly reason: 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'MALFORMED' | 'WRONG_SIGNER' };

/** Checks the id against the body and the signature against the signer, and (optionally) the signer against the one expected. */
export async function verifySigned(s: SignedPromise, expectedSigner?: string): Promise<Verification> {
  if (expectedSigner !== undefined && s.signer !== expectedSigner) return { ok: false, reason: 'WRONG_SIGNER' };
  if (!verifyPromiseId(s.promise)) return { ok: false, reason: 'ID_MISMATCH' };
  if (!/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'MALFORMED' };
  try {
    const key = await getPublicKeyFromAddress(toAddress(s.signer));
    const ok = await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.promise.id));
    return ok ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}
