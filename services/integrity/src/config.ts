// Configuration of the organic-volume attester: which governed crosses it watches, where the order list comes from, and how it is allowed to behave. A JSON file named by
// VOLUME_ATTESTER_CONFIG. Nothing secret is in it.
//
//   {
//     "apiBase": "https://api.example.org",      // the Opening Cross API: its order list and its declared-team flags
//     "crosses": ["<cross address>", ...],       // governed crosses whose charter names this attester
//     "stateDir": "/var/lib/volume-attester",    // funding and placement caches; kept so a restart repeats no call, and bundle evidence outlives the explorer's seven days
//     "bundles": true,                           // check Jito bundles (default true)
//     "minChangeBps": 100,                       // post again when the figure moved this much (default 100 = 1%)
//     "maxIncreaseFactor": 4,                    // hold a figure more than this many times the last one (default 4; 0 turns it off)
//     "serviceFunders": ["<address>", ...],      // exchanges and faucets to ignore when linking wallets
//     "traceBudgetSecs": 120,                    // stop starting wallet traces after this long in one pass
//     "policy": { "minLowerBps": 5000, ... }     // any field of the guard policy (guard.ts); the version string is kept so a decision says which policy made it
//   }
import { type Address, isAddress } from '@solana/kit';
import { DEFAULT_ORGANIC_POLICY, type OrganicPolicy } from '@opening-cross/integrity';

export class ConfigError extends Error {}

export type VolumeConfig = {
  apiBase: string;
  crosses: Address[];
  stateDir: string;
  bundles: boolean;
  minChangeBps: number;
  maxIncreaseFactor: number;
  serviceFunders: Set<string>;
  traceBudgetSecs: number;
  policy: OrganicPolicy;
};

const bad = (path: string, message: string): never => {
  throw new ConfigError(`${path}: ${message}`);
};
const obj = (v: unknown, path: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(path, 'must be an object'));
const num = (v: unknown, path: string, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : bad(path, `must be a number from ${min} to ${max}`));
const KEYS = ['apiBase', 'crosses', 'stateDir', 'bundles', 'minChangeBps', 'maxIncreaseFactor', 'serviceFunders', 'traceBudgetSecs', 'policy', 'allowInsecure'];
const POLICY_NUMBERS = ['minLowerBps', 'minIndependentGroups', 'maxInorganicBps', 'maxUnprovenBps', 'maxUncheckedPlacementsBps', 'minWeightedOrders'] as const;

export function parseConfig(raw: unknown): VolumeConfig {
  const c = obj(raw, 'config');
  const extra = Object.keys(c).filter((k) => !KEYS.includes(k));
  if (extra.length) bad('config', `unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}; the fields are ${KEYS.join(', ')}`);
  const api = typeof c.apiBase === 'string' ? c.apiBase : bad('config.apiBase', 'must be a URL');
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return bad('config.apiBase', 'is not a URL');
  }
  if (url.protocol !== 'https:' && !(c.allowInsecure === true && url.protocol === 'http:')) bad('config.apiBase', 'must be https (set allowInsecure for a local http API)');
  if (!Array.isArray(c.crosses) || c.crosses.length === 0) bad('config.crosses', 'name at least one cross');
  const crosses = (c.crosses as unknown[]).map((x, i) => (typeof x === 'string' && isAddress(x) ? x : bad(`config.crosses[${i}]`, 'must be a base58 Solana address')));
  if (new Set(crosses).size !== crosses.length) bad('config.crosses', 'a cross is listed twice');
  const stateDir = typeof c.stateDir === 'string' && c.stateDir.length > 0 ? c.stateDir : bad('config.stateDir', 'name a directory for the caches');
  const policyIn = c.policy === undefined ? {} : obj(c.policy, 'config.policy');
  const policy: OrganicPolicy = { ...DEFAULT_ORGANIC_POLICY };
  for (const [k, v] of Object.entries(policyIn)) {
    if (k === 'version') policy.version = typeof v === 'string' && v.length > 0 ? v : bad('config.policy.version', 'must be a non-empty string');
    else if ((POLICY_NUMBERS as readonly string[]).includes(k)) (policy as unknown as Record<string, number>)[k] = num(v, `config.policy.${k}`, 0, 10_000_000);
    else bad(`config.policy.${k}`, `unknown policy field; the fields are version, ${POLICY_NUMBERS.join(', ')}`);
  }
  if (c.policy !== undefined && policyIn.version === undefined) policy.version = `${DEFAULT_ORGANIC_POLICY.version}+operator`;
  return {
    apiBase: api.replace(/\/+$/, ''),
    crosses,
    stateDir,
    bundles: c.bundles === undefined ? true : c.bundles === true || c.bundles === false ? c.bundles : bad('config.bundles', 'must be true or false'),
    minChangeBps: c.minChangeBps === undefined ? 100 : num(c.minChangeBps, 'config.minChangeBps', 1, 10_000),
    maxIncreaseFactor: c.maxIncreaseFactor === undefined ? 4 : num(c.maxIncreaseFactor, 'config.maxIncreaseFactor', 0, 1_000_000),
    serviceFunders: new Set(c.serviceFunders === undefined ? [] : Array.isArray(c.serviceFunders) ? (c.serviceFunders as unknown[]).map((x, i) => (typeof x === 'string' && isAddress(x) ? x : bad(`config.serviceFunders[${i}]`, 'must be a base58 Solana address'))) : bad('config.serviceFunders', 'must be a list')),
    traceBudgetSecs: c.traceBudgetSecs === undefined ? 120 : num(c.traceBudgetSecs, 'config.traceBudgetSecs', 1, 86_400),
    policy,
  };
}
