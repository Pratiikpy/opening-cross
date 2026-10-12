// The server half of the MPP "charge" intent on Solana (draft-solana-charge-00, pull mode: type="transaction"), as a front
// for the same gate that serves x402. This module only decides whether a credential answers a challenge this server issued;
// checking the transaction, the ledger, settlement and delivery are shared with x402 (gate.ts).
//
// Scope, stated plainly:
//   offered   charge intent, SPL token or Token-2022 mint, fee sponsored by the server (feePayer: true), pull mode
//   refused   type="signature" (push mode; the specification forbids it with fee sponsorship), type="bundle" (confidential
//             transfers), splits, native SOL, the session intent
// Compute-budget instructions may come in either order, because the official client (solana-foundation/mpp-sdk) emits the
// price before the limit, while the x402 scheme fixes limit then price.
import { randomBytes } from 'node:crypto';
import { toBase64Url } from './codec.js';
import { type MppNetwork, type MppRequest, MPP_INTENT, MPP_METHOD, type ChallengeParams, decodeJsonParam, encodeOpaque, encodeRequest, challengeId, formatChallenge, parseCredential, verifyChallengeId } from './mpp-wire.js';
import { type PaymentPayload, type PaymentRequirements, WireError } from './types.js';

export type MppProblem = 'malformed-credential' | 'invalid-challenge' | 'payment-expired' | 'verification-failed';

export type MppOptions = {
  /** The `realm` of challenges: the protection space, normally the API's hostname. */
  realm: string;
  network: MppNetwork;
  /** Decimals of the payment mint. */
  decimals: number;
  /** Token program that owns the payment mint. */
  tokenProgram: string;
};

export type MppFrontOptions = {
  secret: Uint8Array;
  asset: string;
  payTo: string;
  /** CAIP-2 identifier of the cluster, as the facilitator knows it. */
  network: string;
  ttlSeconds: number;
  maxTimeoutSeconds: number;
  now: () => number;
  mpp: MppOptions;
};

export type Admission =
  | { ok: true; payload: PaymentPayload; required: PaymentRequirements; challengeId: string }
  | { ok: false; problem: MppProblem; code: string; message: string };

const bad = (problem: MppProblem, code: string, message: string): Admission => ({ ok: false, problem, code, message });
const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export class MppFront {
  constructor(private readonly o: MppFrontOptions) {}

  /** A fresh challenge for one request at one price, as the value of a WWW-Authenticate header. */
  challenge(p: { requestKey: string; amount: bigint; description?: string }, feePayer: string): { header: string; params: ChallengeParams } {
    const request: MppRequest = {
      amount: p.amount.toString(),
      currency: this.o.asset,
      recipient: this.o.payTo,
      ...(p.description ? { description: p.description.slice(0, 256) } : {}),
      // The client writes this into a Memo instruction; the server requires that it did, which ties the payment to this challenge.
      externalId: toBase64Url(randomBytes(8)),
      methodDetails: { network: this.o.mpp.network, decimals: this.o.mpp.decimals, tokenProgram: this.o.mpp.tokenProgram, feePayer: true, feePayerKey: feePayer },
    };
    const base = {
      realm: this.o.mpp.realm,
      method: MPP_METHOD,
      intent: MPP_INTENT,
      request: encodeRequest(request),
      expires: isoSeconds(this.o.now() + this.o.ttlSeconds * 1000),
      // The request this challenge was issued for. It is part of what the id binds, so it cannot be moved to another request.
      opaque: encodeOpaque({ rk: p.requestKey }),
    };
    const params: ChallengeParams = { id: challengeId(this.o.secret, base), ...base, ...(p.description ? { description: p.description } : {}) };
    return { header: formatChallenge(params), params };
  }

  /** Decides whether an `Authorization: Payment` value is a payment for this request at this price. */
  admit(authorization: string, p: { requestKey: string; amount: bigint }, feePayers: readonly string[]): Admission {
    let cred;
    try {
      cred = parseCredential(authorization);
    } catch (e) {
      return bad('malformed-credential', e instanceof WireError ? e.code : 'malformed-credential', e instanceof Error ? e.message : 'the credential could not be read');
    }
    const c = cred.challenge;
    if (c.method !== MPP_METHOD || c.intent !== MPP_INTENT) return bad('invalid-challenge', 'invalid-challenge', `this server issues ${MPP_METHOD}/${MPP_INTENT} challenges`);
    if (c.realm !== this.o.mpp.realm) return bad('invalid-challenge', 'invalid-challenge', 'the challenge was issued for another realm');
    if (!verifyChallengeId(this.o.secret, c)) return bad('invalid-challenge', 'invalid-challenge', 'the challenge id does not match its parameters: this server did not issue it');
    // The id holds, so the parameters are ours. Expiry is checked on the server's clock, not the client's.
    if (!c.expires || Date.parse(c.expires) < Math.floor(this.o.now() / 1000) * 1000) return bad('payment-expired', 'challenge_expired', 'the challenge expired; use the fresh challenge');

    let rk: unknown;
    let request: MppRequest;
    try {
      rk = (decodeJsonParam(c.opaque ?? '', 'opaque') as { rk?: unknown }).rk;
      request = decodeJsonParam(c.request, 'request') as MppRequest;
    } catch {
      return bad('invalid-challenge', 'invalid-challenge', 'the challenge parameters could not be read');
    }
    if (rk !== p.requestKey) return bad('invalid-challenge', 'challenge_invalid', 'the payment was not made for this request');
    const d = request.methodDetails;
    if (request.amount !== p.amount.toString()) return bad('invalid-challenge', 'challenge_invalid', 'the price changed since this challenge was issued; use the fresh challenge');
    if (request.currency !== this.o.asset || request.recipient !== this.o.payTo || d?.feePayer !== true || typeof d.feePayerKey !== 'string' || typeof request.externalId !== 'string') {
      return bad('invalid-challenge', 'challenge_invalid', 'the challenge does not describe a payment this server accepts');
    }
    if (!feePayers.includes(d.feePayerKey)) return bad('invalid-challenge', 'fee_payer_not_managed_by_facilitator', 'the challenge names a fee payer this server does not use');

    const payload = cred.payload;
    if (payload.type === 'signature') return bad('verification-failed', 'push_mode_not_accepted', 'type="signature" cannot be used when the server sponsors fees (draft-solana-charge-00 section 8.4); send type="transaction"');
    if (payload.type !== 'transaction' || typeof payload.transaction !== 'string') return bad('malformed-credential', 'unsupported_payload_type', `payload.type "${String(payload.type)}" is not offered; send type="transaction"`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload.transaction) || payload.transaction.length > 4096) return bad('malformed-credential', 'invalid_payload', 'payload.transaction must be base64 of at most 1232 bytes');

    const required: PaymentRequirements = { scheme: 'exact', network: this.o.network, amount: request.amount, asset: this.o.asset, payTo: this.o.payTo, maxTimeoutSeconds: this.o.maxTimeoutSeconds, extra: { feePayer: d.feePayerKey, memo: request.externalId } };
    return { ok: true, required, challengeId: c.id, payload: { x402Version: 2, accepted: required, payload: { transaction: payload.transaction } } };
  }
}
