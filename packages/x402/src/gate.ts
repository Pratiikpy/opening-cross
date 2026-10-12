// The server side of x402 for one paid resource, independent of any web framework. Order of events, chosen so that a
// buyer is never charged for something that was not delivered:
//   no payment      -> 402 with fresh requirements (the caller has already validated the request and prepared a preview)
//   payment present -> decode, check it answers this challenge, check the transaction without any network call, claim it
//                      in the ledger, verify and simulate it with the facilitator, run the work, and only then settle.
// If the work fails, nothing settles and the same payment can be presented again. If settlement is not confirmed, the
// payment stays pending and a retry of the same request is served once it lands.
import { createHash } from 'node:crypto';
import { type ChallengeTerms, checkChallenge, mintChallenge } from './challenge.js';
import { decodeBase64Json, encodeBase64Json } from './codec.js';
import { X402_VERSION } from './constants.js';
import type { Facilitator, Profile } from './facilitator.js';
import { MppFront, type MppOptions, type MppProblem } from './mpp.js';
import { MPP_METHOD, encodeReceipt, problem as problemBody } from './mpp-wire.js';
import { inspectTransaction } from './inspect.js';
import type { PaymentLedger } from './ledger.js';
import { type PaymentPayload, type PaymentRequired, type PaymentRequirements, type ResourceInfo, type SettleResponse, WireError, parsePaymentPayload, sameRequirements } from './types.js';
import { checkExactTransaction } from './verify.js';

export const HEADER_REQUIRED = 'PAYMENT-REQUIRED';
export const HEADER_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HEADER_RESPONSE = 'PAYMENT-RESPONSE';
export const HEADER_RECEIPT = 'payment-receipt';
export const HEADER_CHALLENGE = 'www-authenticate';

export type GateEvent = { type: 'challenge' | 'claimed' | 'rejected' | 'aborted' | 'settled' | 'unconfirmed' | 'redelivered' | 'facilitator_error'; route: string; reason?: string; paymentKey?: string };

export type GateOptions = {
  facilitator: Facilitator;
  ledger: PaymentLedger;
  /** CAIP-2 network the payments settle on. */
  network: string;
  asset: string;
  payTo: string;
  /** Keys the challenge MACs. At least 32 bytes. */
  secret: Uint8Array;
  maxTimeoutSeconds?: number;
  /** Also accept the MPP charge intent (`Authorization: Payment`). Without it only x402 is served. */
  mpp?: MppOptions;
  /** How long a challenge stays payable. */
  challengeTtlSeconds?: number;
  now?: () => number;
  onEvent?: (e: GateEvent) => void;
};

export type PaidRequest = {
  /** The route template, recorded in the ledger (`/v1/paid/proof/:cross`). */
  route: string;
  resource: ResourceInfo;
  /** Names this exact request (see requestKey). A payment is good for this and no other. */
  requestKey: string;
  amount: bigint;
  /** Value of the PAYMENT-SIGNATURE header, if the buyer sent one. */
  paymentHeader: string | undefined;
  /** Value of the Authorization header, read only when it carries a Payment credential (MPP). */
  authorization?: string | undefined;
};

export type Delivery<T> = { status: number; body: T; headers?: Record<string, string> };

export type GateOutcome<T> =
  | { kind: 'challenge'; status: 402; required: PaymentRequired; headers: Record<string, string> }
  | { kind: 'rejected'; status: 400 | 402 | 409 | 503; code: string; message: string; required?: PaymentRequired; headers: Record<string, string>; settlement?: SettleResponse; /** RFC 9457 body, set for MPP callers. */ problem?: string }
  | { kind: 'passthrough'; status: number; body: T; headers: Record<string, string> }
  | { kind: 'paid'; status: number; body: T; headers: Record<string, string>; settlement: SettleResponse; redelivered: boolean; delivered: () => Promise<void> };

/** A stable name for a request: its method, path, query and body, so a payment cannot be moved to another request. */
export function requestKeyOf(r: { method: string; path: string; query?: Record<string, string | string[] | undefined>; body?: unknown }): string {
  const q = Object.entries(r.query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort().join(',') : v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const body = r.body === undefined || r.body === null ? '' : createHash('sha256').update(JSON.stringify(r.body)).digest('hex');
  return createHash('sha256').update(`${r.method.toUpperCase()}\n${r.path}\n${q}\n${body}`).digest('hex');
}

/** How long a pending attempt may last before it is taken to belong to a process that died. A request waits at most the confirmation timeout. */
const STALE_PENDING_SECONDS = 150;

type RejectOpts = { fresh?: boolean; retryAfter?: number; paymentKey?: string; settlement?: SettleResponse; profile?: Profile; problem?: MppProblem };

const header = (required: PaymentRequired) => ({ [HEADER_REQUIRED]: encodeBase64Json(required) });

export class X402Gate {
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly ttl: number;
  private feePayers: { at: number; list: string[] } | null = null;

  private readonly mpp: MppFront | null;

  constructor(private readonly o: GateOptions) {
    if (o.secret.length < 32) throw new Error('the challenge secret must be at least 32 bytes');
    this.now = o.now ?? Date.now;
    this.timeout = o.maxTimeoutSeconds ?? 60;
    this.ttl = o.challengeTtlSeconds ?? 120;
    this.mpp = o.mpp ? new MppFront({ secret: o.secret, asset: o.asset, payTo: o.payTo, network: o.network, ttlSeconds: this.ttl, maxTimeoutSeconds: this.timeout, now: this.now, mpp: o.mpp }) : null;
  }

  /** The WWW-Authenticate challenge for one request, when MPP is configured. */
  private async mppChallenge(p: Pick<PaidRequest, 'resource' | 'requestKey' | 'amount'>): Promise<Record<string, string>> {
    if (!this.mpp) return {};
    const feePayer = (await this.signers())[0]!;
    return { [HEADER_CHALLENGE]: this.mpp.challenge({ requestKey: p.requestKey, amount: p.amount, ...(p.resource.description ? { description: p.resource.description } : {}) }, feePayer).header };
  }

  private emit(e: GateEvent) {
    this.o.onEvent?.(e);
  }

  private async signers(): Promise<string[]> {
    if (this.feePayers && this.now() - this.feePayers.at < 60_000) return this.feePayers.list;
    const s = await this.o.facilitator.supported();
    const list = s.signers['solana:*'] ?? [];
    if (list.length === 0) throw new Error('the facilitator reports no fee payer');
    this.feePayers = { at: this.now(), list };
    return list;
  }

  private terms(amount: bigint, requestKey: string): ChallengeTerms {
    return { requestKey, network: this.o.network, asset: this.o.asset, payTo: this.o.payTo, amount: amount.toString() };
  }

  private requirements(amount: bigint, feePayer: string, memo: string): PaymentRequirements {
    return { scheme: 'exact', network: this.o.network, amount: amount.toString(), asset: this.o.asset, payTo: this.o.payTo, maxTimeoutSeconds: this.timeout, extra: { feePayer, memo } };
  }

  /** Fresh payment requirements for a request. Each call carries its own nonce and expiry. */
  async challenge(p: Pick<PaidRequest, 'resource' | 'requestKey' | 'amount'>, error?: string): Promise<PaymentRequired> {
    const feePayer = (await this.signers())[0]!;
    const memo = mintChallenge(this.o.secret, this.terms(p.amount, p.requestKey), this.now(), this.ttl);
    return { x402Version: X402_VERSION, ...(error ? { error } : {}), resource: p.resource, accepts: [this.requirements(p.amount, feePayer, memo)] };
  }

  private async reject<T>(p: PaidRequest, status: 400 | 402 | 409 | 503, code: string, message: string, opts: RejectOpts = {}): Promise<GateOutcome<T>> {
    this.emit({ type: 'rejected', route: p.route, reason: code, ...(opts.paymentKey ? { paymentKey: opts.paymentKey.slice(0, 12) } : {}) });
    const headers: Record<string, string> = {};
    let required: PaymentRequired | undefined;
    if (opts.fresh) {
      try {
        required = await this.challenge(p, message);
        Object.assign(headers, header(required), await this.mppChallenge(p));
      } catch {
        // The facilitator is unreachable; the rejection stands without fresh requirements.
      }
    }
    const mpp = opts.profile === 'mpp';
    if (opts.settlement && !mpp) headers[HEADER_RESPONSE] = encodeBase64Json(opts.settlement);
    if (opts.retryAfter) headers['retry-after'] = String(opts.retryAfter);
    // An MPP caller is told in the form the specification fixes: 402 for every payment failure, with a Problem Details body.
    const out: GateOutcome<T> = { kind: 'rejected', status: mpp && status === 400 ? 402 : status, code, message, headers, ...(required ? { required } : {}), ...(opts.settlement ? { settlement: opts.settlement } : {}) };
    if (mpp) out.problem = problemBody(opts.problem ?? 'verification-failed', code.replace(/_/g, ' '), message, out.status);
    return out;
  }

  /**
   * Serves one request. `work` must be safe to run before payment settles: it reads, it does not change anything, and it
   * throws for a request that cannot be answered, which the caller maps to a 4xx without any charge.
   */
  async run<T>(p: PaidRequest, work: () => Promise<Delivery<T>>): Promise<GateOutcome<T>> {
    if (p.paymentHeader) return this.runX402(p, work);
    if (p.authorization && this.mpp && /^Payment\s/i.test(p.authorization)) return this.runMpp(p, work);
    try {
      const required = await this.challenge(p, `${HEADER_SIGNATURE} header is required`);
      this.emit({ type: 'challenge', route: p.route });
      return { kind: 'challenge', status: 402, required, headers: { ...header(required), ...(await this.mppChallenge(p)) } };
    } catch {
      this.emit({ type: 'facilitator_error', route: p.route, reason: 'supported' });
      return this.reject(p, 503, 'facilitator_unavailable', 'payments are temporarily unavailable; retry shortly', { retryAfter: 5 });
    }
  }

  private async runMpp<T>(p: PaidRequest, work: () => Promise<Delivery<T>>): Promise<GateOutcome<T>> {
    let signers: string[];
    try {
      signers = await this.signers();
    } catch {
      this.emit({ type: 'facilitator_error', route: p.route, reason: 'supported' });
      return this.reject(p, 503, 'facilitator_unavailable', 'payments are temporarily unavailable; retry shortly', { retryAfter: 5, profile: 'mpp' });
    }
    const adm = this.mpp!.admit(p.authorization!, p, signers);
    if (!adm.ok) return this.reject(p, 402, adm.code, adm.message, { fresh: true, profile: 'mpp', problem: adm.problem });
    let key: string;
    let payer: string;
    try {
      const tx = inspectTransaction(adm.payload.payload.transaction);
      const check = await checkExactTransaction(tx, adm.required, { feePayers: signers, anyComputeBudgetOrder: true });
      if (!check.ok) return this.reject(p, 402, check.reason, check.message ?? 'the payment transaction was refused', { fresh: true, profile: 'mpp' });
      key = tx.messageHash;
      payer = check.payer;
    } catch (e) {
      if (e instanceof WireError) return this.reject(p, 402, e.code, e.message, { fresh: true, profile: 'mpp', problem: 'malformed-credential' });
      throw e;
    }
    const claim = await this.o.ledger.claim({ paymentKey: key, protocol: 'mpp', payer, route: p.route, amount: p.amount, mint: this.o.asset, payTo: this.o.payTo, network: this.o.network, requestHash: p.requestKey });
    if (claim.outcome === 'exists') return this.existing(p, key, claim.attempt, work, 'mpp', adm.challengeId);
    this.emit({ type: 'claimed', route: p.route, paymentKey: key.slice(0, 12) });
    return this.serve(p, key, adm.payload, adm.required, 'mpp', adm.challengeId, work);
  }

  private async runX402<T>(p: PaidRequest, work: () => Promise<Delivery<T>>): Promise<GateOutcome<T>> {
    let payload: PaymentPayload;
    try {
      payload = parsePaymentPayload(decodeBase64Json(p.paymentHeader!, HEADER_SIGNATURE));
    } catch (e) {
      if (e instanceof WireError) return this.reject(p, 400, e.code, e.message, { fresh: true });
      throw e;
    }

    // The payment must answer a challenge this server issued for this request, at this price, that has not run out.
    const memo = payload.accepted.extra.memo;
    if (!memo) return this.reject(p, 402, 'challenge_missing', 'the payment does not carry the challenge memo; request fresh requirements and pay those', { fresh: true });
    const verdict = checkChallenge(this.o.secret, memo, this.terms(p.amount, p.requestKey), this.now());
    if (!verdict.ok) {
      const text = { challenge_expired: 'the challenge expired; use the fresh requirements', challenge_invalid: 'the payment was not made for this request at this price', challenge_malformed: 'the challenge memo is malformed' }[verdict.code];
      return this.reject(p, 402, verdict.code, text, { fresh: true });
    }
    let signers: string[];
    try {
      signers = await this.signers();
    } catch {
      this.emit({ type: 'facilitator_error', route: p.route, reason: 'supported' });
      return this.reject(p, 503, 'facilitator_unavailable', 'payments are temporarily unavailable; retry shortly', { retryAfter: 5 });
    }
    const required = this.requirements(p.amount, payload.accepted.extra.feePayer, memo);
    if (!signers.includes(payload.accepted.extra.feePayer)) return this.reject(p, 402, 'fee_payer_not_managed_by_facilitator', 'the payment names a fee payer this server does not use', { fresh: true });
    if (!sameRequirements(payload.accepted, required)) return this.reject(p, 402, 'accepted_requirements_mismatch', 'the payment does not match the requirements for this request', { fresh: true });

    // A look at the transaction that needs no network: its shape, its transfer and the payer's signature.
    let key: string;
    let payer: string;
    try {
      const tx = inspectTransaction(payload.payload.transaction);
      const check = await checkExactTransaction(tx, required, { feePayers: signers });
      if (!check.ok) return this.reject(p, 402, check.reason, check.message ?? 'the payment transaction was refused', { fresh: true });
      key = tx.messageHash;
      payer = check.payer;
    } catch (e) {
      if (e instanceof WireError) return this.reject(p, 400, e.code, e.message, { fresh: true });
      throw e;
    }

    const claim = await this.o.ledger.claim({ paymentKey: key, protocol: 'x402', payer, route: p.route, amount: p.amount, mint: this.o.asset, payTo: this.o.payTo, network: this.o.network, requestHash: p.requestKey });
    if (claim.outcome === 'exists') return this.existing(p, key, claim.attempt, work, 'x402', '');
    this.emit({ type: 'claimed', route: p.route, paymentKey: key.slice(0, 12) });
    return this.serve(p, key, payload, required, 'x402', '', work);
  }

  /** The receipt header of a settled payment, in the form of the protocol it arrived over. */
  private receipt(profile: Profile, receiptId: string, settlement: SettleResponse): Record<string, string> {
    if (profile === 'x402') return { [HEADER_RESPONSE]: encodeBase64Json(settlement) };
    return { [HEADER_RECEIPT]: encodeReceipt({ method: MPP_METHOD, challengeId: receiptId, reference: settlement.transaction, status: 'success', timestamp: new Date(this.now()).toISOString() }) };
  }

  /** Verify, serve, settle, in that order, for a payment this request has claimed. Ends in settled, failed or aborted. */
  private async serve<T>(p: PaidRequest, key: string, payload: PaymentPayload, required: PaymentRequirements, profile: Profile, receiptId: string, work: () => Promise<Delivery<T>>): Promise<GateOutcome<T>> {
    const rej = (status: 400 | 402 | 409 | 503, code: string, message: string, opts: RejectOpts = {}) => this.reject<T>(p, status, code, message, { ...opts, profile });
    try {
      let valid;
      try {
        valid = await this.o.facilitator.verify(payload, required, { profile });
      } catch {
        await this.o.ledger.aborted(key, 'facilitator unreachable at verify');
        this.emit({ type: 'facilitator_error', route: p.route, reason: 'verify' });
        return rej(503, 'facilitator_unavailable', 'payments are temporarily unavailable; the payment was not used, retry shortly', { retryAfter: 5 });
      }
      if (!valid.isValid) {
        await this.o.ledger.failed(key, valid.invalidReason ?? 'verification_failed');
        return rej(402, valid.invalidReason ?? 'verification_failed', valid.invalidMessage ?? 'the payment could not be verified', { fresh: true, paymentKey: key });
      }

      let delivery: Delivery<T>;
      try {
        delivery = await work();
      } catch (e) {
        await this.o.ledger.aborted(key, 'the request failed before settlement');
        this.emit({ type: 'aborted', route: p.route, paymentKey: key.slice(0, 12) });
        throw e;
      }
      if (delivery.status >= 400) {
        await this.o.ledger.aborted(key, `the resource answered ${delivery.status}`);
        this.emit({ type: 'aborted', route: p.route, paymentKey: key.slice(0, 12) });
        return { kind: 'passthrough', status: delivery.status, body: delivery.body, headers: { ...(delivery.headers ?? {}) } };
      }

      let settlement: SettleResponse;
      try {
        settlement = await this.o.facilitator.settle(payload, required, { profile, beforeBroadcast: (signature) => this.o.ledger.recordSignature(key, signature) });
      } catch {
        // Unknown whether it landed. A retry of this request reconciles it against the chain.
        await this.o.ledger.unconfirmed(key).catch(() => undefined);
        this.emit({ type: 'facilitator_error', route: p.route, reason: 'settle' });
        return rej(503, 'settlement_unconfirmed', 'settlement did not answer; do not pay again: retry this same request with the same payment in a few seconds', { retryAfter: 5, paymentKey: key });
      }
      if (!settlement.success) {
        if (settlement.errorReason === 'settlement_unconfirmed') {
          await this.o.ledger.unconfirmed(key);
          this.emit({ type: 'unconfirmed', route: p.route, paymentKey: key.slice(0, 12) });
          return rej(503, 'settlement_unconfirmed', 'the payment transaction was sent but is not confirmed yet; do not pay again: retry this same request with the same payment in a few seconds', { retryAfter: 5, paymentKey: key, settlement });
        }
        await this.o.ledger.failed(key, settlement.errorReason ?? 'settlement_failed');
        return rej(402, settlement.errorReason ?? 'settlement_failed', settlement.errorMessage ?? 'the payment did not settle', { fresh: true, paymentKey: key, settlement });
      }
      await this.o.ledger.settled(key, settlement.transaction);
      this.emit({ type: 'settled', route: p.route, paymentKey: key.slice(0, 12) });
      return {
        kind: 'paid',
        status: delivery.status,
        body: delivery.body,
        headers: { ...(delivery.headers ?? {}), ...this.receipt(profile, receiptId, settlement) },
        settlement,
        redelivered: false,
        delivered: () => this.o.ledger.delivered(key),
      };
    } catch (e) {
      // A bug or a database failure above must not leave the payment pending forever without a record of why.
      if ((await this.o.ledger.get(key))?.status === 'pending') await this.o.ledger.aborted(key, 'internal error before settlement').catch(() => undefined);
      throw e;
    }
  }

  /**
   * Closes attempts a crashed process left pending. One that was never broadcast is released; one the chain confirmed is
   * recorded as settled (its buyer is served on retry); one that failed, or that never landed and whose blockhash has long
   * expired, is failed. Run it on a timer.
   */
  async reconcile(olderThanSeconds = 150, expireAfterSeconds = 600): Promise<{ settled: number; failed: number; released: number; waiting: number }> {
    const out = { settled: 0, failed: 0, released: 0, waiting: 0 };
    for (const a of await this.o.ledger.stale(olderThanSeconds)) {
      if (!a.signature) {
        await this.o.ledger.aborted(a.paymentKey, 'never broadcast');
        out.released++;
        continue;
      }
      const s = this.o.facilitator.settlementStatus ? await this.o.facilitator.settlementStatus(a.signature).catch(() => 'unknown' as const) : 'unknown';
      if (s === 'confirmed' || s === 'finalized') {
        await this.o.ledger.settled(a.paymentKey, a.signature, true);
        out.settled++;
      } else if (s === 'failed' || (this.now() - a.createdAt.getTime() > expireAfterSeconds * 1000 && s !== 'pending')) {
        await this.o.ledger.failed(a.paymentKey, s === 'failed' ? 'the settlement transaction failed on chain' : 'the settlement transaction never landed');
        out.failed++;
      } else out.waiting++;
    }
    return out;
  }

  /** A payment this server has seen. Served again only when it settled for this very request and was never delivered. */
  private async existing<T>(p: PaidRequest, key: string, a: Awaited<ReturnType<PaymentLedger['get']>> & object, work: () => Promise<Delivery<T>>, profile: Profile, receiptId: string): Promise<GateOutcome<T>> {
    // Only an attempt nobody owns is looked into: one the owner gave up on (unconfirmed), or one a dead process left pending.
    // A pending attempt younger than a request can last belongs to a live request, which must be left to finish.
    const orphaned = a.status === 'unconfirmed' || (a.status === 'pending' && this.now() - a.createdAt.getTime() > STALE_PENDING_SECONDS * 1000);
    if (orphaned && a.signature && a.requestHash === p.requestKey && this.o.facilitator.settlementStatus) {
      const s = await this.o.facilitator.settlementStatus(a.signature).catch(() => 'unknown' as const);
      if (s === 'confirmed' || s === 'finalized') {
        await this.o.ledger.settled(key, a.signature, true);
        a = { ...a, status: 'settled', recovered: true, settledAt: new Date(this.now()) };
      } else if (s === 'failed') {
        await this.o.ledger.failed(key, 'the settlement transaction failed on chain');
        return this.reject(p, 402, 'transaction_failed', 'the payment transaction failed on chain; nothing was charged', { fresh: true, paymentKey: key, profile });
      }
    }
    if (a.status === 'pending' || a.status === 'unconfirmed') return this.reject(p, 409, 'payment_in_progress', 'this payment is being processed by another request; retry in a moment', { retryAfter: 2, paymentKey: key, profile });
    if (a.status === 'settled' && a.requestHash === p.requestKey && (await this.o.ledger.takeRedelivery(key, p.requestKey))) {
      // The first response was never marked delivered. The buyer paid for this request, so serve it once more.
      const delivery = await work();
      if (delivery.status < 400) {
        const settlement: SettleResponse = { success: true, transaction: a.signature ?? '', network: this.o.network, payer: a.payer, amount: a.amount.toString() };
        this.emit({ type: 'redelivered', route: p.route, paymentKey: key.slice(0, 12) });
        return { kind: 'paid', status: delivery.status, body: delivery.body, headers: { ...(delivery.headers ?? {}), ...this.receipt(profile, receiptId, settlement) }, settlement, redelivered: true, delivered: () => this.o.ledger.delivered(key) };
      }
    }
    const why = a.status === 'delivered' || a.status === 'settled' ? 'this payment was already used' : `this payment cannot be used again (${a.status})`;
    return this.reject(p, 402, 'payment_already_used', `${why}; pay the fresh requirements for a new response`, { fresh: true, paymentKey: key, profile });
  }
}
