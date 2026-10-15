// Reading the reserve behind an asset from its configured source. A reading is an integer number of the asset's own atoms with the time the source says it holds; anything else (a failed request, a
// field that is missing, a float, a negative number, a figure older than the source allows, a token account that is missing) is a `SourceError`, and the attester then posts nothing.
import { readFile } from 'node:fs/promises';
import { type Address, getAddressEncoder } from '@solana/kit';
import type { Scale, Source } from './config.js';

export class SourceError extends Error {
  constructor(readonly code: 'UNREACHABLE' | 'BAD_RESPONSE' | 'MISSING_FIELD' | 'NOT_AN_INTEGER' | 'STALE_SOURCE' | 'NEGATIVE' | 'TOO_LARGE' | 'MISSING_ACCOUNT' | 'WRONG_MINT', message: string) {
    super(message);
  }
}

export type Reading = { atoms: bigint; /** Unix seconds the source says the figure holds at; null when the source does not say (a chain read is now). */ asOf: bigint | null; detail: string };
export type SourceDeps = {
  now: () => bigint;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<string>;
  /** A chain account (data and owner), null when it does not exist. */
  account: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
};

const U64_MAX = (1n << 64n) - 1n;
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAX_BODY = 1_000_000;

/** The value at a dotted path (`reserves.total`, `data.0.value`) of parsed JSON. */
export function at(json: unknown, path: string): unknown {
  let cur: unknown = json;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') throw new SourceError('MISSING_FIELD', `the response has no "${path}" (stopped at "${part}")`);
    const next = (cur as Record<string, unknown>)[part];
    if (next === undefined) throw new SourceError('MISSING_FIELD', `the response has no "${path}" (no "${part}")`);
    cur = next;
  }
  return cur;
}

/** A non-negative integer from a decimal string or a safe JSON integer. A fraction is refused: rounding it up would overstate the backing, rounding it down is the source's call to make. */
export function integer(v: unknown, what: string): bigint {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new SourceError('NOT_AN_INTEGER', `${what} is ${v}, which is not a whole number of atoms; have the source state integer atoms or set a scale`);
    if (!Number.isSafeInteger(v)) throw new SourceError('NOT_AN_INTEGER', `${what} is ${v}, a number JSON cannot hold exactly; have the source send it as a decimal string`);
    if (v < 0) throw new SourceError('NEGATIVE', `${what} is negative`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    if (/^-/.test(v.trim())) throw new SourceError('NEGATIVE', `${what} is negative`);
    if (!/^[0-9]{1,40}$/.test(v)) throw new SourceError('NOT_AN_INTEGER', `${what} is "${v.slice(0, 40)}", which is not a decimal integer`);
    return BigInt(v);
  }
  throw new SourceError('NOT_AN_INTEGER', `${what} is a ${v === null ? 'null' : typeof v}, not a number`);
}

/** Unix seconds from a number (seconds, or milliseconds when it is that large) or an ISO 8601 string. */
export function timestamp(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return BigInt(Math.floor(v > 1e11 ? v / 1000 : v));
  if (typeof v === 'string' && /^[0-9]{9,13}$/.test(v)) return timestamp(Number(v), what);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return BigInt(Math.floor(t / 1000));
  }
  throw new SourceError('BAD_RESPONSE', `${what} is not a time the attester can read`);
}

export function scaled(value: bigint, s: Scale): bigint {
  const out = (value * s.mul) / s.div;
  if (out > U64_MAX) throw new SourceError('TOO_LARGE', `the figure ${out} does not fit a 64-bit number`);
  return out;
}

function fromJson(body: unknown, s: { valuePath: string; asOfPath?: string; maxStalenessSecs: number; scale: Scale }, now: bigint, where: string): Reading {
  const atoms = scaled(integer(at(body, s.valuePath), `${where} "${s.valuePath}"`), s.scale);
  if (!s.asOfPath) {
    throw new SourceError('MISSING_FIELD', `${where} states no time (asOfPath): a figure with no date cannot be attested, because the attester could not tell a stale one from a fresh one`);
  }
  const asOf = timestamp(at(body, s.asOfPath), `${where} "${s.asOfPath}"`);
  if (asOf > now + 300n) throw new SourceError('BAD_RESPONSE', `${where} is dated ${asOf - now} seconds in the future`);
  if (now - asOf > BigInt(s.maxStalenessSecs)) throw new SourceError('STALE_SOURCE', `${where} is from ${now - asOf} seconds ago; it must be at most ${s.maxStalenessSecs} seconds old`);
  return { atoms, asOf, detail: `${where}: ${atoms} atoms as of ${asOf}` };
}

/** Resolves `env:NAME` header values; a name that is not set is an error, never an empty header. */
export function headersOf(headers: Record<string, string>, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v.startsWith('env:')) {
      const value = env[v.slice(4)];
      if (!value) throw new SourceError('UNREACHABLE', `the header ${k} needs the environment variable ${v.slice(4)}, which is not set`);
      out[k] = value;
    } else out[k] = v;
  }
  return out;
}

export async function readBacking(source: Source, deps: SourceDeps): Promise<Reading> {
  const now = deps.now();
  if (source.type === 'token-accounts') {
    let total = 0n;
    for (const a of source.accounts) {
      const acct = await deps.account(a);
      if (!acct) throw new SourceError('MISSING_ACCOUNT', `the reserve account ${a} does not exist`);
      if ((acct.owner !== SPL_TOKEN && acct.owner !== TOKEN_2022) || acct.data.length < 72) throw new SourceError('MISSING_ACCOUNT', `${a} is not a token account`);
      if (source.mint) {
        const held = Buffer.from(acct.data.subarray(0, 32));
        const expected = Buffer.from(getAddressEncoder().encode(source.mint));
        if (!held.equals(expected)) throw new SourceError('WRONG_MINT', `the reserve account ${a} holds another token than ${source.mint}`);
      }
      total += new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true);
    }
    if (total > U64_MAX) throw new SourceError('TOO_LARGE', 'the reserve accounts together exceed a 64-bit number');
    return { atoms: total, asOf: null, detail: `${source.accounts.length} reserve account(s) hold ${total} atoms` };
  }
  if (source.type === 'file-json') {
    let body: unknown;
    try {
      body = JSON.parse(await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(source.path));
    } catch (e) {
      throw new SourceError('UNREACHABLE', `the report file ${source.path} could not be read as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return fromJson(body, source, now, `the report ${source.path}`);
  }
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(source.url, { headers: { accept: 'application/json', ...headersOf(source.headers, deps.env ?? process.env) }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError('UNREACHABLE', `${source.url} did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new SourceError('BAD_RESPONSE', `${source.url} answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new SourceError('BAD_RESPONSE', `${source.url} answered more than ${MAX_BODY} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SourceError('BAD_RESPONSE', `${source.url} did not answer JSON`);
  }
  return fromJson(body, source, now, source.url);
}
