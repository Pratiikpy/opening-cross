// Building and reading a gate's compliance rules (ADR-0900). The rules live in an extension region of the gate's
// config account, after the bytes the original GateConfig layout uses.
import { type Address, type ReadonlyUint8Array } from '@solana/kit';
import { COUNTRY_BYTES, countryBit } from './country-set.js';
import { CountryPolicy, type Rules, type RulesArgs, getRulesDecoder } from './generated/index.js';

/** Bytes the original `GateConfig` layout reserves: 8 (discriminator) + 164. The rules extension starts here. */
export const CONFIG_BASE_SIZE = 8 + 164;
export const RULES_EXT_MAGIC = 0xe1;
/** Size of the extension region: the magic byte plus the rules' maximum Borsh size. */
export const RULES_EXT_SIZE = 481;
export const MAX_BLACKOUTS = 4;

export type SasRequirementInput = { credential: Address; schema: Address };

export type RulesInput = {
  /** `off` (default), `allow` (only listed countries) or `deny` (listed countries refused). */
  countryPolicy?: 'off' | 'allow' | 'deny';
  /** ISO 3166-1 alpha-2 codes or numeric codes. */
  countries?: readonly (string | number)[];
  minTier?: number;
  requiredFlags?: number;
  oneIdentityOnePass?: boolean;
  /** Live passes already issued before the rules are switched on (init only; ignored by `setRules`). */
  passes?: number;
  maxPasses?: number;
  defaultCap?: bigint;
  issuanceStart?: bigint;
  issuanceEnd?: bigint;
  identity?: SasRequirementInput | null;
  accreditation?: SasRequirementInput | null;
  allowlistRoot?: Uint8Array | null;
  lockPolicy?: { durationSecs: bigint } | null;
  lockDelegate?: Address | null;
  blackouts?: readonly { start: bigint; end: bigint }[];
  affiliateLimit?: { windowSecs: bigint; maxAmount: bigint } | null;
};

const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? null : v);

/** The rules argument for `init_rules` / `set_rules`, with every field explicit. */
export function buildRules(i: RulesInput = {}): RulesArgs {
  const blackouts = [...(i.blackouts ?? [])];
  if (blackouts.length > MAX_BLACKOUTS) throw new Error(`at most ${MAX_BLACKOUTS} blackout windows`);
  while (blackouts.length < MAX_BLACKOUTS) blackouts.push({ start: 0n, end: 0n });
  return {
    version: 1,
    countryPolicy: { off: CountryPolicy.Off, allow: CountryPolicy.Allow, deny: CountryPolicy.Deny }[i.countryPolicy ?? 'off'],
    countries: countrySet(i.countries ?? []),
    minTier: i.minTier ?? 0,
    requiredFlags: i.requiredFlags ?? 0,
    oneIdentityOnePass: i.oneIdentityOnePass ?? true,
    maxPasses: i.maxPasses ?? 0,
    passes: i.passes ?? 0,
    defaultCap: i.defaultCap ?? 0n,
    issuanceStart: i.issuanceStart ?? 0n,
    issuanceEnd: i.issuanceEnd ?? 0n,
    identity: opt(i.identity),
    accreditation: opt(i.accreditation),
    allowlistRoot: opt(i.allowlistRoot),
    lockPolicy: opt(i.lockPolicy),
    lockDelegate: opt(i.lockDelegate),
    blackouts,
    affiliateLimit: opt(i.affiliateLimit),
    reserved: new Uint8Array(32),
  };
}

/** The 125-byte country bit set for a list of alpha-2 or numeric codes. */
export function countrySet(codes: readonly (string | number)[]): Uint8Array {
  const bits = new Uint8Array(COUNTRY_BYTES);
  for (const c of codes) {
    const n = countryBit(c);
    bits[n >> 3]! |= 1 << (n & 7);
  }
  return bits;
}

/** `true` if the set lists the numeric code. */
export function countryListed(set: ReadonlyUint8Array, numeric: number): boolean {
  return numeric >= 0 && numeric < 1000 && ((set[numeric >> 3] ?? 0) >> (numeric & 7)) % 2 === 1;
}

/** Decoded rules from a gate config account's data, or `null` for a gate without rules. */
export function readRules(configData: ReadonlyUint8Array): Rules | null {
  if (configData[CONFIG_BASE_SIZE] !== RULES_EXT_MAGIC) return null;
  return getRulesDecoder().decode(configData.slice(CONFIG_BASE_SIZE + 1));
}
