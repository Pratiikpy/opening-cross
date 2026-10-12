// The wire format of the Machine Payments Protocol "charge" intent on Solana:
//   draft-httpauth-payment-01        the Payment authentication scheme (challenge, credential, receipt)
//   draft-payment-intent-charge-00   the charge intent
//   draft-solana-charge-00           the solana method: request fields, credential payloads, verification
// published at paymentauth.org. Everything that is hashed or compared is JSON canonicalised with RFC 8785 and encoded as
// base64url without padding. A challenge id is HMAC-SHA256 over the fields it binds, so the server needs no storage to
// recognise its own challenges (draft-httpauth-payment-01 section 5.1.2.1.1; its test vectors are in test/mpp.test.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalize, fromBase64Url, toBase64Url } from './codec.js';
import { WireError } from './types.js';

export const MPP_METHOD = 'solana';
export const MPP_INTENT = 'charge';

export type MppNetwork = 'mainnet' | 'devnet' | 'localnet';

export type MppRequest = {
  amount: string;
  /** The mint address, or `sol` for native SOL (not offered here). */
  currency: string;
  recipient: string;
  description?: string;
  /** The merchant's reference. Clients put it in a Memo instruction; this server requires that. */
  externalId?: string;
  methodDetails: { network: MppNetwork; decimals: number; tokenProgram: string; feePayer: boolean; feePayerKey?: string };
};

export type ChallengeParams = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires?: string;
  digest?: string;
  opaque?: string;
  description?: string;
};

/** The fields a challenge id binds, in the order the HMAC input takes them. `description` is excluded by the specification. */
export function challengeInput(c: Omit<ChallengeParams, 'id' | 'description'>): string {
  return [c.realm, c.method, c.intent, c.request, c.expires ?? '', c.digest ?? '', c.opaque ?? ''].join('|');
}

export function challengeId(secret: Uint8Array, c: Omit<ChallengeParams, 'id' | 'description'>): string {
  return toBase64Url(createHmac('sha256', secret).update(challengeInput(c)).digest());
}

export function verifyChallengeId(secret: Uint8Array, c: ChallengeParams): boolean {
  const want = Buffer.from(challengeId(secret, c));
  const given = Buffer.from(c.id);
  return want.length === given.length && timingSafeEqual(want, given);
}

export const encodeRequest = (r: MppRequest): string => toBase64Url(canonicalize(r));
export const encodeOpaque = (o: Record<string, string>): string => toBase64Url(canonicalize(o));

export function decodeJsonParam(b64url: string, what: string): unknown {
  try {
    return JSON.parse(fromBase64Url(b64url, what).toString('utf8'));
  } catch (e) {
    if (e instanceof WireError) throw e;
    throw new WireError('malformed-credential', `${what} is not base64url of JSON`);
  }
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The value of a `WWW-Authenticate: Payment` header. */
export function formatChallenge(c: ChallengeParams): string {
  const parts = [`id=${quote(c.id)}`, `realm=${quote(c.realm)}`, `method=${quote(c.method)}`, `intent=${quote(c.intent)}`, ...(c.expires ? [`expires=${quote(c.expires)}`] : []), ...(c.digest ? [`digest=${quote(c.digest)}`] : []), ...(c.opaque ? [`opaque=${quote(c.opaque)}`] : []), ...(c.description ? [`description=${quote(c.description.slice(0, 256))}`] : []), `request=${quote(c.request)}`];
  return `Payment ${parts.join(', ')}`;
}

/** Every `Payment` challenge in a WWW-Authenticate value, which may hold several challenges of several schemes. */
export function parseChallenges(header: string): ChallengeParams[] {
  const out: ChallengeParams[] = [];
  let i = 0;
  const n = header.length;
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (current && current.id && current.realm && current.method && current.intent && current.request) {
      out.push({ id: current.id, realm: current.realm, method: current.method, intent: current.intent, request: current.request, ...(current.expires ? { expires: current.expires } : {}), ...(current.digest ? { digest: current.digest } : {}), ...(current.opaque ? { opaque: current.opaque } : {}), ...(current.description ? { description: current.description } : {}) });
    }
    current = null;
  };
  while (i < n) {
    while (i < n && /[\s,]/.test(header[i]!)) i++;
    const start = i;
    while (i < n && /[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(header[i]!)) i++;
    const token = header.slice(start, i);
    if (!token) {
      i++;
      continue;
    }
    while (i < n && header[i] === ' ') i++;
    if (header[i] === '=') {
      i++;
      while (i < n && header[i] === ' ') i++;
      let value = '';
      if (header[i] === '"') {
        i++;
        while (i < n && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < n) i++;
          value += header[i++];
        }
        i++;
      } else {
        const vs = i;
        while (i < n && !/[\s,]/.test(header[i]!)) i++;
        value = header.slice(vs, i);
      }
      if (current) current[token.toLowerCase()] = value;
    } else {
      // A token not followed by "=" opens a challenge of that scheme.
      flush();
      if (token.toLowerCase() === 'payment') current = {};
    }
  }
  flush();
  return out;
}

export type Credential = {
  challenge: Omit<ChallengeParams, 'description'> & { description?: string };
  source?: string;
  payload: { type: 'transaction'; transaction: string } | { type: 'signature'; signature: string } | { type: string; [k: string]: unknown };
};

export function encodeCredential(c: Credential): string {
  return `Payment ${toBase64Url(canonicalize(c))}`;
}

/** Parses an `Authorization: Payment <token>` value. Throws WireError('malformed-credential') for anything else. */
export function parseCredential(header: string): Credential {
  const m = /^Payment +([A-Za-z0-9_-]+={0,2})$/i.exec(header.trim());
  if (!m) throw new WireError('malformed-credential', 'the Authorization header is not "Payment <base64url>"');
  if (m[1]!.length > 16_384) throw new WireError('malformed-credential', 'the credential is larger than 16 KiB');
  const j = decodeJsonParam(m[1]!, 'the credential');
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new WireError('malformed-credential', 'the credential must be a JSON object');
  const c = j as { challenge?: Record<string, unknown>; source?: unknown; payload?: Record<string, unknown> };
  const ch = c.challenge;
  if (!ch || typeof ch !== 'object') throw new WireError('malformed-credential', 'the credential has no challenge');
  for (const k of ['id', 'realm', 'method', 'intent', 'request'] as const) if (typeof ch[k] !== 'string' || (ch[k] as string).length === 0 || (ch[k] as string).length > 8192) throw new WireError('malformed-credential', `challenge.${k} must be a non-empty string`);
  for (const k of ['expires', 'digest', 'opaque', 'description', 'header'] as const) if (ch[k] !== undefined && (typeof ch[k] !== 'string' || (ch[k] as string).length > 8192)) throw new WireError('malformed-credential', `challenge.${k} must be a string`);
  if (!c.payload || typeof c.payload !== 'object' || typeof c.payload.type !== 'string') throw new WireError('malformed-credential', 'the credential has no payload.type');
  return {
    challenge: { id: ch.id as string, realm: ch.realm as string, method: ch.method as string, intent: ch.intent as string, request: ch.request as string, ...(ch.expires ? { expires: ch.expires as string } : {}), ...(ch.digest ? { digest: ch.digest as string } : {}), ...(ch.opaque ? { opaque: ch.opaque as string } : {}), ...(ch.description ? { description: ch.description as string } : {}) },
    ...(typeof c.source === 'string' ? { source: c.source.slice(0, 200) } : {}),
    payload: c.payload as Credential['payload'],
  };
}

export type Receipt = { method: string; challengeId: string; reference: string; status: 'success'; timestamp: string };
export const encodeReceipt = (r: Receipt): string => toBase64Url(canonicalize(r));
export const decodeReceipt = (s: string): Receipt => decodeJsonParam(s, 'the receipt') as Receipt;

/** A problem document (RFC 9457) with the problem types of draft-httpauth-payment-01. */
export function problem(type: 'malformed-credential' | 'invalid-challenge' | 'payment-expired' | 'verification-failed' | 'payment-required', title: string, detail: string, status = 402): string {
  return JSON.stringify({ type: `https://paymentauth.org/problems/${type}`, title, status, detail });
}
