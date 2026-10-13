// Request-body parsing shared by the route files that build unsigned transactions. Every field is validated before any chain read or
// transaction build, and every failure is a `RequestError(400)` that names the field.
import { type Address, isAddress } from '@solana/kit';
import { RequestError } from '../tx.js';

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

export function obj(v: unknown, what = 'request body'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, `${what} must be a JSON object`);
  return v as Record<string, unknown>;
}
export function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
export function u64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s) || BigInt(s) > U64_MAX) throw new RequestError(400, `${field} must be an unsigned 64-bit integer (decimal string)`);
  return BigInt(s);
}
export function i64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,19}$/.test(s) || BigInt(s) > I64_MAX) throw new RequestError(400, `${field} must be a non-negative 64-bit integer (decimal string)`);
  return BigInt(s);
}
export function int(v: unknown, field: string, max: number, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new RequestError(400, `${field} must be an integer in [${min}, ${max}]`);
  return v;
}
export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new RequestError(400, `${field} must be true or false`);
  return v;
}
export function hex32(v: unknown, field: string): Uint8Array {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new RequestError(400, `${field} must be 32 bytes of hex`);
  return Uint8Array.from(Buffer.from(v, 'hex'));
}
export function list<T>(v: unknown, field: string, max: number, each: (x: unknown, i: number) => T): T[] {
  if (!Array.isArray(v)) throw new RequestError(400, `${field} must be an array`);
  if (v.length > max) throw new RequestError(400, `${field} holds at most ${max} entries`);
  return v.map((x, i) => each(x, i));
}
/** Present and not null. */
export const has = (b: Record<string, unknown>, k: string) => b[k] !== undefined && b[k] !== null;
export const opt = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === undefined || v === null ? null : f(v));

/** Refuses keys the route does not know, so a misspelt rule is an error instead of a silently ignored default. */
export function only(b: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw new RequestError(400, `${what}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}; the fields are ${keys.join(', ')}`);
}

export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));
