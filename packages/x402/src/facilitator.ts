// The facilitator interface of x402 (POST /verify, POST /settle, GET /supported) and a self-hosted implementation for the
// `exact` scheme on Solana: verify decodes and inspects the payer's partially signed transaction and simulates it with
// the fee payer's signature added; settle adds that signature for real, sends the transaction and waits for confirmation.
import { type Address, type KeyPairSigner, getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder, getBase64Encoder, partiallySignTransaction } from '@solana/kit';
import type { InspectedTransaction } from './inspect.js';
import { inspectTransaction } from './inspect.js';
import type { SvmRpc } from './network.js';
import { type PaymentPayload, type PaymentRequirements, type SettleResponse, type SupportedResponse, type VerifyResponse, WireError, sameRequirements } from './types.js';
import { type StaticCheckContext, checkExactTransaction } from './verify.js';

/** Which wire protocol a payment arrived over. MPP clients lay out compute-budget instructions in the other order. */
export type Profile = 'x402' | 'mpp';

export type SettleHooks = {
  profile?: Profile;
  /** Called with the transaction's signature after it is fully signed and before it is broadcast, so the caller can record it. */
  beforeBroadcast?: (signature: string) => Promise<void>;
};

export type SettlementStatus = 'confirmed' | 'finalized' | 'failed' | 'pending' | 'unknown';

export interface Facilitator {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements, opts?: { profile?: Profile }): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, hooks?: SettleHooks): Promise<SettleResponse>;
  /** What the chain says about a settlement transaction this facilitator sent. Optional: a remote facilitator may not offer it. */
  settlementStatus?(signature: string): Promise<SettlementStatus>;
}

export type Commitment = 'confirmed' | 'finalized';

export type LocalFacilitatorOptions = {
  rpc: SvmRpc;
  /** CAIP-2 identifier of the cluster `rpc` serves. */
  network: string;
  /** Keys that may pay fees. Each requirement names one of them. */
  signers: readonly KeyPairSigner[];
  commitment?: Commitment;
  /**
   * What this facilitator will sponsor. A fee payer that signs for whatever requirements a caller sends can be drained by
   * paying oneself, so both lists are required: it pays fees only for transfers of these assets to these recipients.
   */
  policy: { payTo: readonly string[]; assets: readonly string[] };
  limits?: Pick<StaticCheckContext, 'maxPriorityFeeLamports' | 'maxComputeUnitLimit'>;
  /** Poll interval while waiting for confirmation. */
  pollMs?: number;
  /** Longest a settlement waits for confirmation. */
  confirmTimeoutMs?: number;
  /** A fee payer holding less than this many lamports is refused, so it is never drained into failing transactions. */
  minFeePayerLamports?: bigint;
};

const DUPLICATE_TTL_MS = 120_000;

type SimulationError = unknown;

/** Maps a simulation or send error to a stable reason a buyer can act on. */
export function reasonFromError(err: SimulationError, logs: readonly string[] | null | undefined): string {
  const text = JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (text.includes('BlockhashNotFound')) return 'invalid_exact_svm_payload_blockhash_expired';
  if (text.includes('AlreadyProcessed')) return 'duplicate_settlement';
  if (text.includes('InsufficientFundsForFee') || text.includes('AccountNotFound')) return 'fee_payer_unfunded_or_account_missing';
  // The SPL Token error `InsufficientFunds` is custom error 1 and `OwnerMismatch` 4 on the transfer instruction (index 2).
  const m = /"InstructionError":\[2,\{"Custom":(\d+)\}\]/.exec(text);
  if (m) return m[1] === '1' ? 'insufficient_funds' : `token_program_error_${m[1]}`;
  if (logs?.some((l) => /insufficient funds/i.test(l))) return 'insufficient_funds';
  return 'transaction_simulation_failed';
}

export class LocalFacilitator implements Facilitator {
  private readonly signers: Map<string, KeyPairSigner>;
  private readonly inflight = new Map<string, number>();
  private readonly commitment: Commitment;
  private readonly pollMs: number;
  private readonly confirmTimeoutMs: number;

  constructor(private readonly o: LocalFacilitatorOptions) {
    if (o.signers.length === 0) throw new Error('a facilitator needs at least one fee payer key');
    this.signers = new Map(o.signers.map((s) => [s.address as string, s]));
    this.commitment = o.commitment ?? 'confirmed';
    this.pollMs = o.pollMs ?? 500;
    this.confirmTimeoutMs = o.confirmTimeoutMs ?? 60_000;
  }

  get feePayers(): readonly string[] {
    return [...this.signers.keys()];
  }

  async supported(): Promise<SupportedResponse> {
    const first = this.feePayers[0]!;
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: this.o.network, extra: { feePayer: first } }],
      extensions: [],
      signers: { 'solana:*': [...this.feePayers] },
    };
  }

  /** Lamports of each fee payer, so an operator can alert before payments start failing. */
  async balances(): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const a of this.feePayers) out[a] = (await this.o.rpc.getBalance(a as Address, { commitment: 'confirmed' }).send()).value;
    return out;
  }

  private ctx(profile: Profile = 'x402'): StaticCheckContext {
    return { feePayers: this.feePayers, ...(this.o.limits ?? {}), ...(profile === 'mpp' ? { anyComputeBudgetOrder: true } : {}) };
  }

  private requirementsError(payload: PaymentPayload, req: PaymentRequirements): string | null {
    if (payload.accepted.scheme !== 'exact' || req.scheme !== 'exact') return 'unsupported_scheme';
    if (req.network !== this.o.network) return 'invalid_network';
    if (!this.o.policy.payTo.includes(req.payTo)) return 'pay_to_not_sponsored';
    if (!this.o.policy.assets.includes(req.asset)) return 'asset_not_sponsored';
    if (payload.accepted.network !== req.network) return 'network_mismatch';
    if (!sameRequirements(payload.accepted, req)) return 'accepted_requirements_mismatch';
    return null;
  }

  /** Static checks and a simulation. Returns the inspected transaction and the signed wire bytes on success. */
  private async prepare(payload: PaymentPayload, req: PaymentRequirements, profile: Profile = 'x402'): Promise<{ ok: true; tx: InspectedTransaction; payer: Address; wire: string; signature: string } | { ok: false; res: VerifyResponse }> {
    const bad = this.requirementsError(payload, req);
    if (bad) return { ok: false, res: { isValid: false, invalidReason: bad } };
    let tx: InspectedTransaction;
    try {
      tx = inspectTransaction(payload.payload.transaction);
    } catch (e) {
      if (e instanceof WireError) return { ok: false, res: { isValid: false, invalidReason: e.code, invalidMessage: e.message } };
      throw e;
    }
    const check = await checkExactTransaction(tx, req, this.ctx(profile));
    if (!check.ok) return { ok: false, res: { isValid: false, invalidReason: check.reason, ...(check.message ? { invalidMessage: check.message } : {}), ...(check.payer ? { payer: check.payer } : {}) } };

    const feePayer = this.signers.get(tx.feePayer)!;
    if (this.o.minFeePayerLamports !== undefined) {
      const lamports = (await this.o.rpc.getBalance(feePayer.address, { commitment: 'confirmed' }).send()).value;
      if (lamports < this.o.minFeePayerLamports) return { ok: false, res: { isValid: false, invalidReason: 'fee_payer_balance_too_low', payer: check.payer } };
    }
    const signed = await this.signAndSimulate(payload.payload.transaction, feePayer.address);
    if (!signed.ok) return { ok: false, res: { isValid: false, invalidReason: signed.reason, ...(signed.message ? { invalidMessage: signed.message } : {}), payer: check.payer } };
    return { ok: true, tx, payer: check.payer, wire: signed.wire, signature: signed.signature };
  }

  /** Adds the fee payer's signature to a payer-signed transaction and simulates the result. Used by x402 and MPP alike. */
  async signAndSimulate(base64: string, feePayer: Address): Promise<{ ok: true; wire: string; signature: string } | { ok: false; reason: string; message?: string }> {
    const signer = this.signers.get(feePayer);
    if (!signer) return { ok: false, reason: 'fee_payer_not_managed_by_facilitator' };
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
    const signed = await partiallySignTransaction([signer.keyPair], decoded);
    const wire = getBase64EncodedWireTransaction(signed);
    const sim = await this.o.rpc.simulateTransaction(wire, { encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false }).send();
    if (sim.value.err !== null) {
      const reason = reasonFromError(sim.value.err, sim.value.logs);
      const tail = (sim.value.logs ?? []).slice(-3).join(' | ').slice(0, 300);
      return { ok: false, reason, message: `${JSON.stringify(sim.value.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 200)}${tail ? ` (${tail})` : ''}` };
    }
    return { ok: true, wire, signature: getSignatureFromTransaction(signed) };
  }

  /** Whether a fee payer holds at least the configured minimum. */
  async feePayerFunded(feePayer: Address): Promise<boolean> {
    if (this.o.minFeePayerLamports === undefined) return true;
    return (await this.o.rpc.getBalance(feePayer, { commitment: 'confirmed' }).send()).value >= this.o.minFeePayerLamports;
  }

  /** Sends fully signed bytes and waits for the commitment. `unconfirmed` means it may still land. */
  async broadcast(wire: string, signature: string): Promise<{ ok: true } | { ok: false; reason: 'settlement_unconfirmed' | 'transaction_failed'; message: string }> {
    try {
      await this.o.rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
    } catch (e) {
      // A transaction the network already holds is not a failure. If it is not there either, whether the send reached the
      // network is unknown, so the settlement is reported unconfirmed rather than failed.
      const landed = await this.status(signature).catch(() => null);
      if (landed === null) return { ok: false, reason: 'settlement_unconfirmed', message: `send failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}` };
    }
    const outcome = await this.confirm(signature, wire);
    if (outcome === 'timeout') return { ok: false, reason: 'settlement_unconfirmed', message: 'the transaction was sent but not confirmed in time' };
    return outcome === 'ok' ? { ok: true } : { ok: false, reason: 'transaction_failed', message: outcome };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements, opts: { profile?: Profile } = {}): Promise<VerifyResponse> {
    const p = await this.prepare(payload, req, opts.profile);
    return p.ok ? { isValid: true, payer: p.payer } : p.res;
  }

  async settlementStatus(signature: string): Promise<SettlementStatus> {
    const s = await this.status(signature);
    if (!s) return 'unknown';
    if (s.err !== null) return 'failed';
    return s.confirmationStatus === 'finalized' ? 'finalized' : s.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending';
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements, hooks?: SettleHooks): Promise<SettleResponse> {
    const network = payload.accepted.network;
    const failure = (errorReason: string, payer?: string, errorMessage?: string): SettleResponse => ({ success: false, errorReason, transaction: '', network, ...(payer ? { payer } : {}), ...(errorMessage ? { errorMessage } : {}) });
    // Claim the transaction before any await: two settle calls for one payment must not both reach the network.
    let key: string;
    try {
      key = inspectTransaction(payload.payload.transaction).messageHash;
    } catch (e) {
      return failure(e instanceof WireError ? e.code : 'invalid_payload');
    }
    const now = Date.now();
    for (const [k, t] of this.inflight) if (now - t > DUPLICATE_TTL_MS) this.inflight.delete(k);
    if (this.inflight.has(key)) return failure('duplicate_settlement');
    this.inflight.set(key, now);

    const p = await this.prepare(payload, req, hooks?.profile);
    if (!p.ok) {
      this.inflight.delete(key);
      return failure(p.res.invalidReason ?? 'verification_failed', p.res.payer, p.res.invalidMessage);
    }
    try {
      await hooks?.beforeBroadcast?.(p.signature);
    } catch {
      this.inflight.delete(key);
      return failure('ledger_unavailable', p.payer, 'the payment could not be recorded, so it was not sent');
    }
    const sent = await this.broadcast(p.wire, p.signature);
    if (!sent.ok) return failure(sent.reason, p.payer, sent.message);
    return { success: true, transaction: p.signature, network, payer: p.payer, amount: req.amount };
  }

  private async status(signature: string): Promise<{ err: unknown; confirmationStatus: string | null } | null> {
    const res = await this.o.rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: false }).send();
    const s = res.value[0];
    return s ? { err: s.err, confirmationStatus: s.confirmationStatus ?? null } : null;
  }

  /** Waits until the signature reaches the commitment, resending the same bytes while the blockhash is still valid. */
  private async confirm(signature: string, wire: string): Promise<'ok' | 'timeout' | string> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    let resentAt = Date.now();
    while (Date.now() < deadline) {
      // A rate-limited or briefly unreachable endpoint answers a status poll with an error. That says nothing about the
      // transaction, so it is treated as "not seen yet": the loop keeps resending the same bytes until the deadline.
      const s = await this.status(signature).catch(() => null);
      if (s) {
        if (s.err !== null) return `the transaction failed on chain: ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 200)}`;
        if (s.confirmationStatus === 'finalized' || (this.commitment === 'confirmed' && s.confirmationStatus === 'confirmed')) return 'ok';
      } else if (Date.now() - resentAt > 2_000) {
        resentAt = Date.now();
        await this.o.rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return 'timeout';
  }
}
