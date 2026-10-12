// A fetch that pays. On a 402 it reads the requirements, checks them against the buyer's own limits, builds the
// payment and repeats the request once. The limits are the buyer's protection: a hostile server can ask for any amount,
// any mint, any recipient, so nothing is signed that the caller did not allow.
import type { TransactionSigner } from '@solana/kit';
import { buildExactPayment } from './client.js';
import { decodeBase64Json, encodeBase64Json } from './codec.js';
import { HEADER_CHALLENGE, HEADER_RECEIPT, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE } from './gate.js';
import { MPP_INTENT, MPP_METHOD, type MppRequest, decodeJsonParam, decodeReceipt, encodeCredential, parseChallenges } from './mpp-wire.js';
import type { SvmRpc } from './network.js';
import { type PaymentRequired, type PaymentRequirements, type SettleResponse, WireError, parseRequirements } from './types.js';

export type PayLimits = {
  /** The most the buyer will pay for one request, in the asset's base units. Required: there is no default. */
  maxAmount: bigint;
  /** Only these mints. Omit to accept any mint (not recommended). */
  assets?: readonly string[];
  /** Only these recipients. */
  payTo?: readonly string[];
  /** Only this network (CAIP-2). */
  network?: string;
  /** Only this cluster, when paying over MPP, which names clusters by `mainnet`, `devnet` or `localnet`. */
  mppNetwork?: 'mainnet' | 'devnet' | 'localnet';
};

export type PayFetchOptions = {
  signer: TransactionSigner;
  rpc: SvmRpc;
  limits: PayLimits;
  /** Which protocol to pay over when a server offers both. Default: x402. */
  prefer?: 'x402' | 'mpp';
  fetch?: typeof fetch;
  /** Called after a payment is built and before it is sent, with what is about to be spent. Throw to refuse. */
  beforePay?: (a: PaymentRequirements) => void | Promise<void>;
};

export type Paid = { protocol: 'x402' | 'mpp'; amount: bigint; asset: string; payTo: string; network: string; transaction: string | null; settlement: SettleResponse | null };
export type PayFetchResult = { response: Response; paid: Paid | null };

/** Why a requirement was not paid. */
export class PaymentRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function chooseRequirement(required: PaymentRequired, limits: PayLimits): PaymentRequirements {
  let why = 'the server offered no payment option';
  for (const raw of required.accepts) {
    let a: PaymentRequirements;
    try {
      a = parseRequirements(raw, 'accepts[]');
    } catch (e) {
      why = e instanceof WireError ? e.message : 'malformed option';
      continue;
    }
    if (limits.network && a.network !== limits.network) why = `the server asks to be paid on ${a.network}, not ${limits.network}`;
    else if (limits.assets && !limits.assets.includes(a.asset)) why = `the server asks for mint ${a.asset}, which is not in the allowed list`;
    else if (limits.payTo && !limits.payTo.includes(a.payTo)) why = `the server asks to be paid to ${a.payTo}, which is not in the allowed list`;
    else if (BigInt(a.amount) > limits.maxAmount) why = `the price ${a.amount} is above the limit ${limits.maxAmount}`;
    else return a;
  }
  throw new PaymentRefused('payment_refused', why);
}

/** The MPP challenge in a WWW-Authenticate value that names the solana charge intent, checked against the buyer's limits. */
export function chooseMppChallenge(header: string, limits: PayLimits, nowMs: number) {
  let why = 'the server offered no MPP solana charge challenge';
  for (const c of parseChallenges(header)) {
    if (c.method !== MPP_METHOD || c.intent !== MPP_INTENT) continue;
    let r: MppRequest;
    try {
      r = decodeJsonParam(c.request, 'request') as MppRequest;
    } catch {
      why = 'the challenge request could not be read';
      continue;
    }
    const d = r.methodDetails;
    if (c.expires && Date.parse(c.expires) <= nowMs) why = 'the challenge has already expired';
    else if (!/^[0-9]{1,20}$/.test(String(r.amount)) || r.currency === 'sol') why = 'only token charges are supported';
    else if (limits.mppNetwork && d?.network !== limits.mppNetwork) why = `the server asks to be paid on ${String(d?.network)}, not ${limits.mppNetwork}`;
    else if (limits.assets && !limits.assets.includes(r.currency)) why = `the server asks for mint ${r.currency}, which is not in the allowed list`;
    else if (limits.payTo && !limits.payTo.includes(r.recipient)) why = `the server asks to be paid to ${r.recipient}, which is not in the allowed list`;
    else if (BigInt(r.amount) > limits.maxAmount) why = `the price ${r.amount} is above the limit ${limits.maxAmount}`;
    else if (d?.feePayer !== true || typeof d.feePayerKey !== 'string') why = 'only server-sponsored charges are supported';
    else if ((d as { splits?: unknown }).splits !== undefined) why = 'a charge with splits is not supported';
    else return { challenge: c, request: r };
  }
  throw new PaymentRefused('payment_refused', why);
}

export function createPayFetch(o: PayFetchOptions) {
  const doFetch = o.fetch ?? fetch;
  return async function payFetch(input: string | URL, init: RequestInit = {}): Promise<PayFetchResult> {
    const first = await doFetch(input, init);
    if (first.status !== 402) return { response: first, paid: null };
    const x402Header = first.headers.get(HEADER_REQUIRED);
    const mppHeader = first.headers.get(HEADER_CHALLENGE);
    const useMpp = mppHeader !== null && /(^|[\s,])Payment\s/i.test(mppHeader) && (o.prefer === 'mpp' || !x402Header);
    if (useMpp) {
      const { challenge, request } = chooseMppChallenge(mppHeader!, o.limits, Date.now());
      const accepted: PaymentRequirements = { scheme: 'exact', network: '', amount: request.amount, asset: request.currency, payTo: request.recipient, maxTimeoutSeconds: 60, extra: { feePayer: request.methodDetails.feePayerKey!, ...(request.externalId ? { memo: request.externalId } : {}) } };
      await o.beforePay?.(accepted);
      const built = await buildExactPayment({ rpc: o.rpc, signer: o.signer, requirements: accepted });
      const headers = new Headers(init.headers);
      headers.set('authorization', encodeCredential({ challenge, source: o.signer.address, payload: { type: 'transaction', transaction: built.payload.transaction } }));
      const response = await doFetch(input, { ...init, headers });
      const receipt = response.headers.get(HEADER_RECEIPT);
      let reference: string | null = null;
      if (receipt) {
        try {
          reference = decodeReceipt(receipt).reference;
        } catch {
          reference = null;
        }
      }
      return { response, paid: { protocol: 'mpp', amount: BigInt(request.amount), asset: request.currency, payTo: request.recipient, network: request.methodDetails.network, transaction: reference, settlement: null } };
    }
    if (!x402Header) return { response: first, paid: null };
    const required = decodeBase64Json(x402Header, HEADER_REQUIRED) as PaymentRequired;
    const accepted = chooseRequirement(required, o.limits);
    await o.beforePay?.(accepted);
    const payload = await buildExactPayment({ rpc: o.rpc, signer: o.signer, requirements: accepted, resource: required.resource });
    const headers = new Headers(init.headers);
    headers.set(HEADER_SIGNATURE, encodeBase64Json(payload));
    // One payment per call. If the paid request is refused, the refusal is the answer; nothing is paid twice.
    const response = await doFetch(input, { ...init, headers });
    const settled = response.headers.get(HEADER_RESPONSE);
    const settlement = settled ? (decodeBase64Json(settled, HEADER_RESPONSE) as SettleResponse) : null;
    return { response, paid: { protocol: 'x402', amount: BigInt(accepted.amount), asset: accepted.asset, payTo: accepted.payTo, network: accepted.network, transaction: settlement?.success ? settlement.transaction : null, settlement } };
  };
}
