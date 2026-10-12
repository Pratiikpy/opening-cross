// Header encodings: standard base64 JSON for x402 (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE), base64url
// without padding for MPP, and RFC 8785 canonical JSON, which MPP requires for anything that is hashed or compared.
import { WireError } from './types.js';

export const MAX_HEADER_BYTES = 16 * 1024;

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeBase64Json(header: string, what: string): unknown {
  if (header.length > MAX_HEADER_BYTES) throw new WireError('invalid_payload', `${what} is larger than ${MAX_HEADER_BYTES} bytes`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(header)) throw new WireError('invalid_payload', `${what} is not base64`);
  try {
    // Buffer accepts both the standard and the URL-safe alphabet, and padding or none.
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new WireError('invalid_payload', `${what} is not base64 of JSON`);
  }
}

export const toBase64Url = (bytes: Uint8Array | string): string => Buffer.from(bytes as never).toString('base64url');

export function fromBase64Url(s: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new WireError('malformed-credential', `${what} is not base64url`);
  return Buffer.from(s, 'base64url');
}

/**
 * RFC 8785 JSON Canonicalization for the value space MPP uses: objects, arrays, strings, booleans, null and finite
 * numbers. Property names sort by UTF-16 code unit; strings and numbers serialize as JSON.stringify does, which is the
 * ECMAScript form the RFC specifies.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS cannot serialize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`JCS cannot serialize a ${typeof value}`);
}
