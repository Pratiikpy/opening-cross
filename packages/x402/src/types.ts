// Wire types of x402 protocol version 2 (specs/x402-specification-v2.md in coinbase/x402) for the `exact` scheme on Solana
// (specs/schemes/exact/scheme_exact_svm.md). Parsers here validate shape and sizes only; money rules live in verify.ts.
import { isAddress } from '@solana/kit';
import { X402_VERSION } from './constants.js';

export type ResourceInfo = { url: string; description?: string; mimeType?: string };

export type PaymentRequirements = {
  scheme: 'exact';
  /** CAIP-2: `solana:` plus the first 32 characters of the cluster's genesis hash. */
  network: string;
  /** Token base units, decimal string. */
  amount: string;
  /** Mint address. */
  asset: string;
  /** Owner of the destination associated token account. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string; memo?: string };
};

export type PaymentRequired = {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { transaction: string };
  extensions?: Record<string, unknown>;
};

export type VerifyResponse = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
export type SettleResponse = { success: boolean; errorReason?: string; errorMessage?: string; payer?: string; transaction: string; network: string; amount?: string };
export type SupportedResponse = {
  kinds: { x402Version: number; scheme: string; network: string; extra?: { feePayer: string } }[];
  extensions: string[];
  signers: Record<string, string[]>;
};

export class WireError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_FIELD = 2048;

function str(v: unknown, field: string, max = MAX_FIELD): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new WireError('invalid_payload', `${field} must be a non-empty string of at most ${max} characters`);
  return v;
}

export function parseRequirements(v: unknown, field = 'accepted'): PaymentRequirements {
  if (!isObject(v)) throw new WireError('invalid_payment_requirements', `${field} must be an object`);
  if (v.scheme !== 'exact') throw new WireError('unsupported_scheme', `${field}.scheme must be "exact"`);
  const amount = str(v.amount, `${field}.amount`, 20);
  if (!/^[0-9]{1,20}$/.test(amount)) throw new WireError('invalid_payment_requirements', `${field}.amount must be a decimal integer string`);
  const asset = str(v.asset, `${field}.asset`, 44);
  const payTo = str(v.payTo, `${field}.payTo`, 44);
  if (!isAddress(asset)) throw new WireError('invalid_payment_requirements', `${field}.asset must be a base58 address`);
  if (!isAddress(payTo)) throw new WireError('invalid_payment_requirements', `${field}.payTo must be a base58 address`);
  const timeout = v.maxTimeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new WireError('invalid_payment_requirements', `${field}.maxTimeoutSeconds must be an integer from 1 to 3600`);
  if (!isObject(v.extra)) throw new WireError('invalid_payment_requirements', `${field}.extra must be an object`);
  const feePayer = str(v.extra.feePayer, `${field}.extra.feePayer`, 44);
  if (!isAddress(feePayer)) throw new WireError('invalid_exact_svm_payload_missing_fee_payer', `${field}.extra.feePayer must be a base58 address`);
  const memo = v.extra.memo;
  if (memo !== undefined && (typeof memo !== 'string' || new TextEncoder().encode(memo).length > 256)) throw new WireError('invalid_payment_requirements', `${field}.extra.memo must be a string of at most 256 bytes`);
  return {
    scheme: 'exact',
    network: str(v.network, `${field}.network`, 64),
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: timeout,
    extra: { feePayer, ...(memo === undefined ? {} : { memo }) },
  };
}

export function parsePaymentPayload(v: unknown): PaymentPayload {
  if (!isObject(v)) throw new WireError('invalid_payload', 'the payment must be a JSON object');
  if (v.x402Version !== X402_VERSION) throw new WireError('invalid_x402_version', `x402Version must be ${X402_VERSION}`);
  if (!isObject(v.payload)) throw new WireError('invalid_payload', 'payload must be an object');
  const transaction = str(v.payload.transaction, 'payload.transaction', 4096);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) throw new WireError('invalid_payload', 'payload.transaction must be base64');
  let resource: ResourceInfo | undefined;
  if (v.resource !== undefined) {
    if (!isObject(v.resource)) throw new WireError('invalid_payload', 'resource must be an object');
    resource = { url: str(v.resource.url, 'resource.url') };
    if (typeof v.resource.description === 'string') resource.description = v.resource.description.slice(0, 512);
    if (typeof v.resource.mimeType === 'string') resource.mimeType = v.resource.mimeType.slice(0, 128);
  }
  return { x402Version: X402_VERSION, ...(resource ? { resource } : {}), accepted: parseRequirements(v.accepted), payload: { transaction } };
}

export function parseVerifyResponse(v: unknown): VerifyResponse {
  if (!isObject(v) || typeof v.isValid !== 'boolean') throw new WireError('invalid_facilitator_response', 'a verify response needs a boolean isValid');
  return {
    isValid: v.isValid,
    ...(typeof v.invalidReason === 'string' ? { invalidReason: v.invalidReason } : {}),
    ...(typeof v.invalidMessage === 'string' ? { invalidMessage: v.invalidMessage } : {}),
    ...(typeof v.payer === 'string' ? { payer: v.payer } : {}),
  };
}

export function parseSettleResponse(v: unknown): SettleResponse {
  if (!isObject(v) || typeof v.success !== 'boolean') throw new WireError('invalid_facilitator_response', 'a settle response needs a boolean success');
  return {
    success: v.success,
    transaction: typeof v.transaction === 'string' ? v.transaction : '',
    network: typeof v.network === 'string' ? v.network : '',
    ...(typeof v.errorReason === 'string' ? { errorReason: v.errorReason } : {}),
    ...(typeof v.errorMessage === 'string' ? { errorMessage: v.errorMessage } : {}),
    ...(typeof v.payer === 'string' ? { payer: v.payer } : {}),
    ...(typeof v.amount === 'string' ? { amount: v.amount } : {}),
  };
}

/** Whether two requirements describe the same payment. The memo is compared too: it binds a payment to one challenge. */
export function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && a.asset === b.asset && a.payTo === b.payTo && a.maxTimeoutSeconds === b.maxTimeoutSeconds && a.extra.feePayer === b.extra.feePayer && (a.extra.memo ?? '') === (b.extra.memo ?? '');
}
