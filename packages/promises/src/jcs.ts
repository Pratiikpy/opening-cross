// JSON canonicalisation (RFC 8785, JCS) for the subset promises use: objects, arrays, strings,
// booleans, null and safe integers. Floats are refused outright: a promise carries prices and
// counts as integers or decimal strings, so its bytes, and therefore its id, are the same on every
// machine and in every language.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json | undefined };

export function canonicalize(value: Json): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new RangeError(`promises carry integers only, got ${value}`);
      return String(value);
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) return `[${(value as readonly Json[]).map(canonicalize).join(',')}]`;
  const obj = value as { readonly [k: string]: Json | undefined };
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareUtf16);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k] as Json)}`).join(',')}}`;
}

/** RFC 8785 sorts member names by UTF-16 code units, which is JavaScript's default string order. */
const compareUtf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** sha-256 of the canonical form, lowercase hex. */
export function hashJcs(value: Json): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))));
}
