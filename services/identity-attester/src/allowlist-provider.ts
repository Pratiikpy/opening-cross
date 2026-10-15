// A manual allowlist as a KycProvider: an operator who has verified people by their own process lists their wallets in a
// JSON file. It exists to show the attester is not Cleanverse-shaped, and it is a legitimate provider for an issuer that
// does its own KYC. The file is re-read on every lookup, so an edit (a removal above all) takes effect at the next sync.
//
//   { "wallets": { "<solana address>": { "customerRef": "...", "tier": 1, "country": "IN", "expiresAt": 1893456000,
//       "kycVerified": true, "sanctionsScreened": true, "accredited": false, "frozen": false, "capAtoms": "0" } } }
import { readFile } from 'node:fs/promises';
import { type KycProvider, type ProviderRecord, ProviderUnavailableError } from './provider.js';

type Entry = { customerRef: string; tier: number; country?: string; countries?: string[]; expiresAt?: number; kycVerified?: boolean; sanctionsScreened?: boolean; accredited?: boolean; frozen?: boolean; capAtoms?: string };

function parse(text: string): Map<string, ProviderRecord> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError('the allowlist file is not valid JSON');
  }
  const wallets = (doc as { wallets?: unknown } | null)?.wallets;
  if (typeof wallets !== 'object' || wallets === null || Array.isArray(wallets)) throw new ProviderUnavailableError('the allowlist file needs a "wallets" object');
  const out = new Map<string, ProviderRecord>();
  for (const [addr, raw] of Object.entries(wallets)) {
    const e = raw as Partial<Entry>;
    const fail = (m: string) => new ProviderUnavailableError(`allowlist entry ${addr}: ${m}`);
    if (typeof e?.customerRef !== 'string' || e.customerRef.length === 0) throw fail('customerRef is required');
    if (!Number.isInteger(e.tier) || (e.tier as number) < 0) throw fail('tier must be a non-negative integer');
    if (e.expiresAt !== undefined && (!Number.isInteger(e.expiresAt) || (e.expiresAt as number) < 0)) throw fail('expiresAt must be Unix seconds');
    const countries = e.countries ?? (e.country ? [e.country] : []);
    if (!Array.isArray(countries) || countries.some((c) => typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))) throw fail('country must be an ISO alpha-2 code');
    let cap = 0n;
    if (e.capAtoms !== undefined) {
      if (typeof e.capAtoms !== 'string' || !/^\d{1,20}$/.test(e.capAtoms)) throw fail('capAtoms must be a decimal string');
      cap = BigInt(e.capAtoms);
    }
    out.set(addr, {
      state: e.frozen === true ? 'frozen' : 'active',
      customerRef: e.customerRef,
      tier: e.tier as number,
      countries: countries.map((c) => c.toUpperCase()),
      expiresAt: e.expiresAt ?? 0,
      kycVerified: e.kycVerified === true,
      sanctionsScreened: e.sanctionsScreened === true,
      accredited: e.accredited === true,
      capAtoms: cap,
    });
  }
  return out;
}

export class AllowlistProvider implements KycProvider {
  readonly name = 'manual-allowlist';
  constructor(private readonly path: string) {}

  async lookup(wallet: string): Promise<ProviderRecord> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      throw new ProviderUnavailableError('the allowlist file cannot be read');
    }
    return parse(text).get(wallet) ?? { state: 'none' };
  }
}
