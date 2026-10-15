// The keeper's configuration, read from the environment in one place so that the process (main.ts) and the deploy tests read it the same way. A blank variable is an
// unset one: a compose file that passes `KEEPER_DUTIES: ${KEEPER_DUTIES:-}` hands the process an empty string, and that must mean "the default", not "no duties".
// A value that is not what it should be is an error naming the variable, never a silent zero.
import type { Address } from '@solana/kit';
import { type Duty, parseDuties } from './keeper.js';
import { DEFAULT_PARTNER_FEE_CONFIG, type PartnerFeeConfig } from './partner-fees.js';

export type KeeperConfig = {
  /** Milliseconds between passes. */
  passMs: number;
  /** Creators the keeper serves; empty means every cross it can discover. */
  creators: Address[];
  duties: Set<Duty>;
  dryRun: boolean;
  minRelease: bigint;
  /** Lowercase hex Pyth feed ids the keeper may feed to a circuit breaker. */
  breakerFeeds: Set<string>;
  /** The billing service whose entitlements condition the series duty; null when the series duty serves every series in scope. */
  billingUrl: string | null;
  /** Series authorities served without a subscription. */
  entitlementExempt: Set<string>;
  partnerFees: PartnerFeeConfig;
};

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;
const list = (env: Env, name: string): string[] => (text(env, name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function whole(env: Env, name: string, fallback: number, min: number): number {
  const v = text(env, name);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be a whole number of at least ${min}, got "${v}"`);
  return Number(v);
}

function atoms(env: Env, name: string, fallback: bigint): bigint {
  const v = text(env, name);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number of atoms, got "${v}"`);
  return BigInt(v);
}

export function keeperConfig(env: Env): KeeperConfig {
  const billingUrl = text(env, 'KEEPER_BILLING_URL');
  if (billingUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(billingUrl)) throw new Error(`KEEPER_BILLING_URL must be an http(s) URL, got "${billingUrl}"`);
  return {
    passMs: whole(env, 'PASS_MS', 10_000, 1),
    creators: list(env, 'KEEPER_CREATORS') as Address[],
    duties: parseDuties(text(env, 'KEEPER_DUTIES')),
    dryRun: text(env, 'KEEPER_DRY_RUN') === '1',
    minRelease: atoms(env, 'KEEPER_MIN_RELEASE', 1n),
    breakerFeeds: new Set(list(env, 'KEEPER_BREAKER_FEEDS').map((f) => f.toLowerCase())),
    billingUrl: billingUrl ?? null,
    entitlementExempt: new Set(list(env, 'KEEPER_ENTITLEMENT_EXEMPT')),
    partnerFees: {
      everySecs: whole(env, 'KEEPER_PARTNER_FEE_EVERY_SECS', DEFAULT_PARTNER_FEE_CONFIG.everySecs, 1),
      minQuote: atoms(env, 'KEEPER_MIN_PARTNER_QUOTE', DEFAULT_PARTNER_FEE_CONFIG.minQuote),
      minBase: atoms(env, 'KEEPER_MIN_PARTNER_BASE', DEFAULT_PARTNER_FEE_CONFIG.minBase),
    },
  };
}
