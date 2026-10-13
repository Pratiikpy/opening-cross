// Signed maker quotes (PRODUCT_FEATURES W9, Z7).
//
// A quote is a maker's signed statement that one of its orders is resting in a cross: "my order with this nonce, on this
// side, at this price and size, until this time". It exists so an aggregator, a router or a taker can discover a maker's
// liquidity without scanning the chain and without trusting anyone's claim to speak for the maker.
//
// What a quote is NOT: it is not binding. Cancelling an order is free until the call closes, and cross_core has no
// instruction that checks a signature, so nothing on chain stops a maker from cancelling a quoted order. Backing is
// therefore re-checked against the chain at the moment it is used (`checkBacking`), and a quote whose order is gone,
// changed or already settled is reported as such. An on-chain verified quote (an Ed25519 instruction read by the
// program) would need a change to cross_core and is listed as a program item in docs/FEATURE_STATUS.md.
import { type Address, address as toAddress, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';
import { OrderSide, OrderState, getOrderDecoder, orderAddress } from '@opening-cross/sdk';

export const QUOTE_SCHEMA = 'opening-cross/maker-quote/v1';
export const QUOTE_DOMAIN = 'opening-cross/maker-quote/v1\n';
/** The longest a quote may live, in seconds. A quote is evidence about a resting order, so it is short. */
export const MAX_QUOTE_TTL_SECONDS = 24 * 60 * 60;

export type QuoteSide = 'buy' | 'sell';

export type QuoteBody = {
  readonly schema: typeof QUOTE_SCHEMA;
  /** The maker: owner of the resting order, and the key that signs. */
  readonly maker: string;
  readonly cross: string;
  readonly side: QuoteSide;
  /** Limit price on the cross's grid, in quote atoms per price scale, decimal string. */
  readonly price: string;
  /** Base atoms, decimal string. */
  readonly quantity: string;
  /** The nonce of the resting order that backs the quote, decimal string. */
  readonly orderNonce: string;
  /** Unix seconds. After this the quote is void. */
  readonly expiresAt: number;
  /** Tells two quotes with otherwise equal fields apart: 16 to 64 lowercase hex characters. */
  readonly nonce: string;
};

export type SignedQuote = { readonly body: QuoteBody; readonly id: string; readonly signature: string };

export class QuoteError extends Error {
  override readonly name = 'QuoteError';
}

const U64 = /^(0|[1-9][0-9]{0,19})$/;
const NONCE = /^[0-9a-f]{16,64}$/;
const U64_MAX = (1n << 64n) - 1n;

export const isSolanaAddress = (a: unknown): a is string => {
  if (typeof a !== 'string') return false;
  try {
    toAddress(a);
    return true;
  } catch {
    return false;
  }
};

const u64 = (v: unknown, field: string): bigint => {
  if (typeof v !== 'string' || !U64.test(v) || BigInt(v) > U64_MAX) throw new QuoteError(`${field} must be an unsigned 64-bit integer as a decimal string`);
  return BigInt(v);
};

/** Throws a QuoteError naming the first thing wrong with the body. Pass `now` to also bound the lifetime. */
export function validateQuote(b: QuoteBody, now?: number): void {
  if (b.schema !== QUOTE_SCHEMA) throw new QuoteError(`unknown schema ${String(b.schema)}`);
  if (!isSolanaAddress(b.maker)) throw new QuoteError('maker must be a Solana address');
  if (!isSolanaAddress(b.cross)) throw new QuoteError('cross must be a Solana address');
  if (b.side !== 'buy' && b.side !== 'sell') throw new QuoteError('side must be "buy" or "sell"');
  if (u64(b.price, 'price') === 0n) throw new QuoteError('price must be greater than zero');
  if (u64(b.quantity, 'quantity') === 0n) throw new QuoteError('quantity must be greater than zero');
  u64(b.orderNonce, 'orderNonce');
  if (!Number.isSafeInteger(b.expiresAt) || b.expiresAt <= 0) throw new QuoteError('expiresAt must be a unix time in seconds');
  if (!NONCE.test(b.nonce)) throw new QuoteError('nonce must be 16 to 64 lowercase hex characters');
  if (now !== undefined && b.expiresAt - now > MAX_QUOTE_TTL_SECONDS) throw new QuoteError(`a quote may live at most ${MAX_QUOTE_TTL_SECONDS} seconds`);
}

export const quoteId = (b: QuoteBody): string => {
  validateQuote(b);
  return hashJcs(b as unknown as Json);
};

const message = (id: string): Uint8Array => new TextEncoder().encode(QUOTE_DOMAIN + id);

export async function signQuote(body: QuoteBody, keyPair: CryptoKeyPair): Promise<SignedQuote> {
  const id = quoteId(body);
  return { body, id, signature: bytesToHex(await signBytes(keyPair.privateKey, message(id))) };
}

export type QuoteVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'MALFORMED' | 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'EXPIRED' };

/** Checks shape, id and the maker's signature, and that the quote has not expired at `now`. Reads nothing from the network. */
export async function verifyQuote(q: SignedQuote, now: number): Promise<QuoteVerdict> {
  try {
    validateQuote(q.body, now);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  try {
    if (quoteId(q.body) !== q.id) return { ok: false, reason: 'ID_MISMATCH' };
    if (!/^[0-9a-f]{128}$/.test(q.signature)) return { ok: false, reason: 'BAD_SIGNATURE' };
    const key = await getPublicKeyFromAddress(toAddress(q.body.maker) as Address);
    if (!(await verifySignature(key, hexToBytes(q.signature) as SignatureBytes, message(q.id)))) return { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  return q.body.expiresAt <= now ? { ok: false, reason: 'EXPIRED' } : { ok: true };
}

export type BackingReader = (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;

export type BackingReason = 'NO_ORDER' | 'NOT_OWNED_BY_PROGRAM' | 'WRONG_MAKER' | 'WRONG_CROSS' | 'WRONG_SIDE' | 'PRICE_DIFFERS' | 'SIZE_DIFFERS' | 'NOT_OPEN';

export type Backing = { readonly backed: true; readonly remaining: bigint } | { readonly backed: false; readonly reason: BackingReason; readonly detail: string };

/**
 * Reads the order the quote points at and says whether it is still resting as quoted. Sealed orders have no price on chain
 * until they are revealed, so a quote backed by one is `NOT_OPEN` until then: a sealed order is not liquidity anyone can see.
 */
export async function checkBacking(q: SignedQuote, read: BackingReader, crossCoreProgram: Address): Promise<Backing> {
  const orderAddr = await orderAddress(toAddress(q.body.cross), toAddress(q.body.maker), BigInt(q.body.orderNonce));
  const acct = await read(orderAddr);
  if (!acct) return { backed: false, reason: 'NO_ORDER', detail: `order ${orderAddr} does not exist: it was cancelled, claimed or never placed` };
  if (acct.owner !== crossCoreProgram) return { backed: false, reason: 'NOT_OWNED_BY_PROGRAM', detail: `${orderAddr} is not owned by cross_core` };
  const o = getOrderDecoder().decode(acct.data);
  if (o.owner !== q.body.maker) return { backed: false, reason: 'WRONG_MAKER', detail: 'the order belongs to another wallet' };
  if (o.cross !== q.body.cross) return { backed: false, reason: 'WRONG_CROSS', detail: 'the order belongs to another cross' };
  if ((o.side === OrderSide.Buy ? 'buy' : 'sell') !== q.body.side) return { backed: false, reason: 'WRONG_SIDE', detail: 'the order is on the other side' };
  if (o.state !== OrderState.Revealed) return { backed: false, reason: 'NOT_OPEN', detail: 'the order is sealed and not revealed, so it is not visible liquidity' };
  if (o.price !== BigInt(q.body.price)) return { backed: false, reason: 'PRICE_DIFFERS', detail: `the order rests at ${o.price}, not ${q.body.price}` };
  if (o.quantity < BigInt(q.body.quantity)) return { backed: false, reason: 'SIZE_DIFFERS', detail: `the order is for ${o.quantity}, less than the ${q.body.quantity} quoted` };
  return { backed: true, remaining: o.quantity };
}
