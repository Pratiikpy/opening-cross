// A payment is tied to one challenge through the memo the `exact` scheme lets a seller set (`extra.memo`; the payer's
// transaction must carry exactly that memo). The memo holds an expiry, a random nonce and a keyed MAC over the request it
// was issued for and the terms of payment, so a server can tell, without storing anything, that a payment was made for
// this request, at this price, before the challenge ran out. A payment made for one route cannot be replayed on another.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The memo is as short as it can be: Memo v3 costs about 350 compute units per byte, and a client that pays with the
// common 20,000-unit limit has to fit the transfer (about 6,000) and the memo inside it. 36 bytes costs about 14,000.
const PREFIX = 'oc1';
const DOMAIN = 'oc402.v1';
const MAC_BYTES = 12;
const NONCE_BYTES = 6;

export type ChallengeTerms = { requestKey: string; network: string; asset: string; payTo: string; amount: string };

export type ChallengeCheck = { ok: true; expiresAt: number } | { ok: false; code: 'challenge_malformed' | 'challenge_invalid' | 'challenge_expired' };

const mac = (secret: Uint8Array, exp: number, nonce: string, t: ChallengeTerms): Buffer =>
  createHmac('sha256', secret).update([DOMAIN, exp, nonce, t.requestKey, t.network, t.asset, t.payTo, t.amount].join('\n')).digest().subarray(0, MAC_BYTES);

export function mintChallenge(secret: Uint8Array, t: ChallengeTerms, nowMs: number, ttlSeconds: number, nonce = randomBytes(NONCE_BYTES).toString('base64url')): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  return `${PREFIX}.${exp.toString(36)}.${nonce}.${mac(secret, exp, nonce, t).toString('base64url')}`;
}

export function checkChallenge(secret: Uint8Array, memo: string, t: ChallengeTerms, nowMs: number): ChallengeCheck {
  const m = /^oc1\.([0-9a-z]{5,9})\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{16})$/.exec(memo);
  if (!m) return { ok: false, code: 'challenge_malformed' };
  const exp = parseInt(m[1]!, 36);
  const given = Buffer.from(m[3]!, 'base64url');
  const want = mac(secret, exp, m[2]!, t);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, code: 'challenge_invalid' };
  if (Math.floor(nowMs / 1000) > exp) return { ok: false, code: 'challenge_expired' };
  return { ok: true, expiresAt: exp };
}
