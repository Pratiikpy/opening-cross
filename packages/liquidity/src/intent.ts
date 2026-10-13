// Signed intents (PRODUCT_FEATURES W9 "aggregator intents").
//
// An intent is a wallet's signed instruction: "buy or sell this much of this pair in the next cross that suits it, at
// no worse than this price, until this time". An aggregator, an agent or a router submits it; the service matches it to a
// cross and answers with the UNSIGNED place-order transaction for that cross. The owner's wallet still signs and sends
// that transaction: an intent does not give anyone the right to move the owner's funds, and cross_core has no way to
// delegate that right (a delegated mandate would need a program, see docs/FEATURE_STATUS.md). What the signature does is
// make the instruction attributable and replay-proof, so a router can hold it, match it and prove what it was asked.
import { type Address, address as toAddress, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';
import { isSolanaAddress } from './quote.js';

export const INTENT_SCHEMA = 'opening-cross/intent/v1';
export const INTENT_DOMAIN = 'opening-cross/intent/v1\n';
export const MAX_INTENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type IntentBody = {
  readonly schema: typeof INTENT_SCHEMA;
  /** The wallet that will sign the order, and the key that signs the intent. */
  readonly owner: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly side: 'buy' | 'sell';
  /** Base atoms, decimal string. */
  readonly quantity: string;
  /** The worst price accepted, in the cross's price units; null accepts any price on the grid. */
  readonly limitPrice: string | null;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly nonce: string;
};

export type SignedIntent = { readonly body: IntentBody; readonly id: string; readonly signature: string };

export class IntentError extends Error {
  override readonly name = 'IntentError';
}

const U64 = /^(0|[1-9][0-9]{0,19})$/;
const NONCE = /^[0-9a-f]{16,64}$/;

export function validateIntent(b: IntentBody, now?: number): void {
  if (b.schema !== INTENT_SCHEMA) throw new IntentError(`unknown schema ${String(b.schema)}`);
  for (const [f, v] of [['owner', b.owner], ['baseMint', b.baseMint], ['quoteMint', b.quoteMint]] as const) if (!isSolanaAddress(v)) throw new IntentError(`${f} must be a Solana address`);
  if (b.baseMint === b.quoteMint) throw new IntentError('the base and quote mints must differ');
  if (b.side !== 'buy' && b.side !== 'sell') throw new IntentError('side must be "buy" or "sell"');
  if (typeof b.quantity !== 'string' || !U64.test(b.quantity) || BigInt(b.quantity) === 0n || BigInt(b.quantity) >= 1n << 64n) throw new IntentError('quantity must be a positive 64-bit integer as a decimal string');
  if (b.limitPrice !== null && (typeof b.limitPrice !== 'string' || !U64.test(b.limitPrice) || BigInt(b.limitPrice) === 0n || BigInt(b.limitPrice) >= 1n << 64n)) throw new IntentError('limitPrice must be null or a positive 64-bit integer as a decimal string');
  if (!Number.isSafeInteger(b.expiresAt) || b.expiresAt <= 0) throw new IntentError('expiresAt must be a unix time in seconds');
  if (!NONCE.test(b.nonce)) throw new IntentError('nonce must be 16 to 64 lowercase hex characters');
  if (now !== undefined && b.expiresAt - now > MAX_INTENT_TTL_SECONDS) throw new IntentError(`an intent may live at most ${MAX_INTENT_TTL_SECONDS} seconds`);
}

export const intentId = (b: IntentBody): string => {
  validateIntent(b);
  return hashJcs(b as unknown as Json);
};

const message = (id: string): Uint8Array => new TextEncoder().encode(INTENT_DOMAIN + id);

export async function signIntent(body: IntentBody, keyPair: CryptoKeyPair): Promise<SignedIntent> {
  const id = intentId(body);
  return { body, id, signature: bytesToHex(await signBytes(keyPair.privateKey, message(id))) };
}

export type IntentVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'MALFORMED' | 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'EXPIRED' };

export async function verifyIntent(s: SignedIntent, now: number): Promise<IntentVerdict> {
  try {
    validateIntent(s.body, now);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  try {
    if (intentId(s.body) !== s.id) return { ok: false, reason: 'ID_MISMATCH' };
    if (!/^[0-9a-f]{128}$/.test(s.signature)) return { ok: false, reason: 'BAD_SIGNATURE' };
    const key = await getPublicKeyFromAddress(toAddress(s.body.owner) as Address);
    if (!(await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.id)))) return { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  return s.body.expiresAt <= now ? { ok: false, reason: 'EXPIRED' } : { ok: true };
}

export type CrossFacts = {
  readonly address: string;
  readonly state: string;
  readonly baseMint: string | null;
  readonly quoteMint: string;
  readonly openTs: bigint;
  readonly closeTs: bigint;
  readonly sealed: boolean;
};

export type IntentMatch = { readonly cross: CrossFacts; readonly reason: null } | { readonly cross: CrossFacts; readonly reason: string };

/**
 * Which crosses could take this intent right now. A cross is eligible when it trades the pair, is Live, its window is open
 * and still open for at least `minSecondsLeft`. Every cross that is not eligible comes back with the reason, so an empty
 * answer is explained. The caller then ranks the eligible ones (the router's quote does).
 */
export function matchCrosses(intent: IntentBody, crosses: readonly CrossFacts[], now: bigint, minSecondsLeft = 30n): IntentMatch[] {
  return crosses.map((c) => {
    if (c.baseMint !== intent.baseMint || c.quoteMint !== intent.quoteMint) return { cross: c, reason: 'trades a different pair' };
    if (c.state !== 'Live') return { cross: c, reason: `is ${c.state}, not Live` };
    if (now < c.openTs) return { cross: c, reason: 'has not opened yet' };
    if (c.closeTs - now < minSecondsLeft) return { cross: c, reason: now >= c.closeTs ? 'has closed' : `closes in under ${minSecondsLeft} s, too late to be sure a transaction lands` };
    return { cross: c, reason: null };
  });
}
