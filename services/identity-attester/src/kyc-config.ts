// Configuration from the environment. Secrets are paths to files outside the repository, never values.
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { CleanverseClient, loadCredentials } from '@opening-cross/cleanverse';
import { AllowlistProvider } from './allowlist-provider.js';
import { CleanverseProvider, type IdentityKey } from './cleanverse-provider.js';
import { DEFAULT_POLICY, type Policy, validatePolicy } from './decision.js';
import type { KycProvider } from './provider.js';

export type Env = Record<string, string | undefined>;

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const int = (env: Env, name: string, d: number) => {
  const v = env[name];
  if (v === undefined || v === '') return d;
  if (!/^\d{1,12}$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
};
const optInt = (env: Env, name: string): number | null => (env[name] === undefined || env[name] === '' ? null : int(env, name, 0));
const flag = (env: Env, name: string, d: boolean) => (env[name] === undefined || env[name] === '' ? d : ['1', 'true', 'yes'].includes(env[name]!.toLowerCase()));

/** The signing key: a Solana CLI keypair file (JSON array of 64 bytes) at ATTESTER_KEYPAIR. */
export async function loadSigner(env: Env) {
  const path = need(env, 'ATTESTER_KEYPAIR');
  let bytes: number[];
  try {
    bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
  } catch {
    throw new Error(`ATTESTER_KEYPAIR (${path}) is not a readable keypair file`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('ATTESTER_KEYPAIR must hold a JSON array of 64 bytes');
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

/** The identity-id secret from ATTESTER_SECRET_FILE: 32 or more bytes as hex or Base64 text. */
export function loadSecret(env: Env): Uint8Array {
  const path = need(env, 'ATTESTER_SECRET_FILE');
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`ATTESTER_SECRET_FILE (${path}) is not readable`);
  }
  const bytes = /^[0-9a-fA-F]{64,}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (bytes.length < 32) throw new Error('ATTESTER_SECRET_FILE must hold at least 32 bytes as hex or Base64');
  return Uint8Array.from(bytes);
}

export function loadPolicy(env: Env): Policy {
  const priority = (env.ATTESTER_COUNTRY_PRIORITY ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return validatePolicy({
    ...DEFAULT_POLICY,
    retailMin: int(env, 'ATTESTER_TIER_RETAIL_MIN', DEFAULT_POLICY.retailMin),
    accreditedMin: optInt(env, 'ATTESTER_TIER_ACCREDITED_MIN'),
    qualifiedMin: optInt(env, 'ATTESTER_TIER_QUALIFIED_MIN'),
    countryPriority: priority,
    requireCountry: flag(env, 'ATTESTER_REQUIRE_COUNTRY', DEFAULT_POLICY.requireCountry),
    assertSanctionsScreened: flag(env, 'ATTESTER_ASSERT_SANCTIONS_SCREENED', DEFAULT_POLICY.assertSanctionsScreened),
    maxTtlSecs: int(env, 'ATTESTER_MAX_TTL_SECS', DEFAULT_POLICY.maxTtlSecs),
    minRemainingSecs: int(env, 'ATTESTER_MIN_REMAINING_SECS', DEFAULT_POLICY.minRemainingSecs),
    defaultCapAtoms: BigInt(env.ATTESTER_DEFAULT_CAP_ATOMS && /^\d{1,20}$/.test(env.ATTESTER_DEFAULT_CAP_ATOMS) ? env.ATTESTER_DEFAULT_CAP_ATOMS : '0'),
  });
}

/** `ATTESTER_PROVIDER` = `cleanverse` (default) or `allowlist` (with `ATTESTER_ALLOWLIST_FILE`). */
export function loadProvider(env: Env): KycProvider {
  const which = env.ATTESTER_PROVIDER ?? 'cleanverse';
  if (which === 'allowlist') return new AllowlistProvider(need(env, 'ATTESTER_ALLOWLIST_FILE'));
  if (which !== 'cleanverse') throw new Error(`ATTESTER_PROVIDER must be cleanverse or allowlist, got ${JSON.stringify(which)}`);
  const creds = loadCredentials(env);
  if (!creds.config) throw new Error(`Cleanverse credentials are not available: ${creds.reason}`);
  const key = (env.ATTESTER_CLEANVERSE_IDENTITY_KEY ?? 'customerId') as IdentityKey;
  if (!['customerId', 'kycHash', 'cvRecordId'].includes(key)) throw new Error('ATTESTER_CLEANVERSE_IDENTITY_KEY must be customerId, kycHash or cvRecordId');
  return new CleanverseProvider(new CleanverseClient(creds.config), {
    identityKey: key,
    ...(env.ATTESTER_CLEANVERSE_NOT_FOUND_PATTERN ? { notFoundPattern: new RegExp(env.ATTESTER_CLEANVERSE_NOT_FOUND_PATTERN, 'i') } : {}),
    assumeKyc: flag(env, 'ATTESTER_CLEANVERSE_ASSUME_KYC', false),
  });
}

export const kycCredentialName = (env: Env) => env.ATTESTER_CREDENTIAL_NAME ?? 'oc-attester';
