// Referrals (PRODUCT_FEATURES W6: "optional 10% referrer"). The share is 10% of the protocol fee that a referred
// owner's order generated; it comes out of the protocol's take, never out of the integrator's or the user's.
//
// This is the router's per-owner referral: it is settled from the protocol fee wallet, and every payout is an ordinary
// token transfer anyone can check against the ledger. A cross can also name one referrer in its own rules, and then
// `finalize` pays that referrer a share of the protocol fee itself (ADR-0460, `referralShare` in schedule.ts); the
// ledger records that share (ledger.ts) and the router leaves such a cross alone (`referralLines`).
//
// A referral is a document the referred owner signs with their wallet key. Without that signature anyone could
// register a referrer for somebody else's orders. The signature covers a domain prefix and the hash of the
// canonical body, the same way a signed promise does.
import { type Address, address as toAddress, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';
import { BPS } from './schedule.js';

/** The referrer's share of the protocol fee an order generated, in bps of that fee. */
export const REFERRAL_SHARE_BPS = 1_000;
export const REFERRAL_SCHEMA = 'opening-cross/referral/v1';
export const REFERRAL_DOMAIN = 'opening-cross/referral/v1\n';

export type ReferralBody = {
  readonly schema: typeof REFERRAL_SCHEMA;
  /** The wallet whose orders are referred; it signs. */
  readonly owner: string;
  /** Who is paid; null revokes the owner's earlier referral from `effectiveFrom` on. */
  readonly referrer: string | null;
  /** Orders placed at or after this unix time (cluster seconds) are referred. */
  readonly effectiveFrom: number;
  /** Distinguishes two documents from the same owner with the same effective time. */
  readonly nonce: string;
};

export type SignedReferral = { readonly body: ReferralBody; readonly id: string; readonly signature: string };

export class ReferralError extends Error {
  override readonly name = 'ReferralError';
}

const NONCE = /^[0-9a-f]{16,64}$/;

export function validateReferral(b: ReferralBody): void {
  if (b.schema !== REFERRAL_SCHEMA) throw new ReferralError(`unknown schema ${String(b.schema)}`);
  if (!Number.isSafeInteger(b.effectiveFrom) || b.effectiveFrom < 0) throw new ReferralError('effectiveFrom must be a non-negative integer');
  if (!NONCE.test(b.nonce)) throw new ReferralError('nonce must be 16 to 64 lowercase hex characters');
  if (b.referrer !== null && b.referrer === b.owner) throw new ReferralError('an owner cannot refer themselves');
  for (const a of [b.owner, ...(b.referrer === null ? [] : [b.referrer])]) {
    try {
      toAddress(a);
    } catch {
      throw new ReferralError(`${a} is not a Solana address`);
    }
  }
}

export const referralId = (b: ReferralBody): string => {
  validateReferral(b);
  return hashJcs(b as unknown as Json);
};

const message = (id: string): Uint8Array => new TextEncoder().encode(REFERRAL_DOMAIN + id);

export async function signReferral(body: ReferralBody, keyPair: CryptoKeyPair): Promise<SignedReferral> {
  const id = referralId(body);
  return { body, id, signature: bytesToHex(await signBytes(keyPair.privateKey, message(id))) };
}

/** True when the id matches the body and the owner's key signed it. */
export async function verifyReferral(s: SignedReferral): Promise<boolean> {
  try {
    if (referralId(s.body) !== s.id || !/^[0-9a-f]{128}$/.test(s.signature)) return false;
    const key = await getPublicKeyFromAddress(toAddress(s.body.owner) as Address);
    return await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.id));
  } catch {
    return false;
  }
}

/** The referrer in force for `owner` at `at`: the latest valid document effective at or before `at`; a revocation ends the referral. */
export function referrerAt(docs: readonly ReferralBody[], owner: string, at: number): string | null {
  let best: ReferralBody | null = null;
  for (const d of docs) {
    if (d.owner !== owner || d.effectiveFrom > at) continue;
    if (!best || d.effectiveFrom > best.effectiveFrom || (d.effectiveFrom === best.effectiveFrom && d.nonce > best.nonce)) best = d;
  }
  return best?.referrer ?? null;
}

export type ReferredOrder = {
  readonly cross: string;
  readonly order: string;
  readonly owner: string;
  readonly side: 'buy' | 'sell';
  /** Unix seconds when the order was placed. */
  readonly placedAt: number;
  /** Quote atoms paid (buy) or earned gross (sell). */
  readonly notional: bigint;
  /** The fee this order paid in escrow mode (sell side); ignored for mint modes. */
  readonly escrowFee: bigint;
};

export type ReferralCross = {
  readonly cross: string;
  readonly supplyMode: 'escrow' | 'mint' | 'deferred-mint';
  readonly protocolBps: number;
  readonly integratorBps: number;
  readonly protocolFee: bigint;
  /**
   * The share of the protocol fee the cross itself pays a referrer at finalize (ADR-0460), when its rules name one. Such a cross already gives away part of the
   * protocol fee on chain, so the router owes nothing on it: paying the router's 10% as well would pay two referrals out of one fee.
   */
  readonly referralShareBps?: number | undefined;
};

export type ReferralLine = { readonly cross: string; readonly order: string; readonly owner: string; readonly referrer: string; readonly protocolFeeShare: bigint; readonly payout: bigint };

/**
 * Per-order payouts for one finalized cross. An order's fee is what the program charged it: the seller's claim fee in
 * escrow mode, `floor(pay x total bps)` for a buyer in a mint mode (the issuer pays the total at finalize; this is the
 * part that came from this buyer). Floors are taken per order, so the sum of attributions never exceeds the fee the
 * program collected, and the sum of payouts never exceeds 10% of the cross's protocol fee.
 */
export function referralLines(cross: ReferralCross, orders: readonly ReferredOrder[], docs: readonly ReferralBody[]): ReferralLine[] {
  const total = BigInt(cross.protocolBps + cross.integratorBps);
  const lines: ReferralLine[] = [];
  if ((cross.referralShareBps ?? 0) > 0) return lines;
  for (const o of orders) {
    const referrer = referrerAt(docs, o.owner, o.placedAt);
    if (!referrer || referrer === o.owner) continue;
    const fee = cross.supplyMode === 'escrow' ? (o.side === 'sell' ? o.escrowFee : 0n) : o.side === 'buy' ? (o.notional * total) / BPS : 0n;
    const protocolShare = total === 0n ? 0n : (fee * BigInt(cross.protocolBps)) / total;
    const payout = (protocolShare * BigInt(REFERRAL_SHARE_BPS)) / BPS;
    if (payout === 0n) continue;
    lines.push({ cross: cross.cross, order: o.order, owner: o.owner, referrer, protocolFeeShare: protocolShare, payout });
  }
  const paid = lines.reduce((a, l) => a + l.payout, 0n);
  if (paid > (cross.protocolFee * BigInt(REFERRAL_SHARE_BPS)) / BPS) throw new ReferralError(`referral payouts ${paid} exceed ${REFERRAL_SHARE_BPS / 100}% of the protocol fee ${cross.protocolFee} on ${cross.cross}`);
  return lines;
}
