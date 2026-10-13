// Environment for the market-maker bot. A missing or malformed value stops the process with a message naming it (exit 2).
import { isAddress } from '@solana/kit';
import { type Strategy, validateStrategy } from './strategy.js';

export type CrossKind = 'launch' | 'reopen' | 'tender' | 'recurring';
const KINDS: readonly CrossKind[] = ['launch', 'reopen', 'tender', 'recurring'];

export type MmConfig = {
  readonly apiUrl: string;
  readonly rpcUrl: string;
  readonly keypairPath: string;
  /** Hex file holding at least 32 random bytes; every salt of a sealed order is derived from it. Absent: sealed crosses are skipped. */
  readonly sealSecretFile: string | null;
  readonly statePath: string;
  readonly logPath: string | null;
  readonly strategy: Strategy;
  /** Only act on crosses made by these creators; empty means any creator. */
  readonly creators: ReadonlySet<string>;
  /** Kinds quoted into. Launches are left out by default: a house order should not be demand in someone's price discovery. */
  readonly kinds: ReadonlySet<CrossKind>;
  /** Operator's fair value per base mint, in quote tokens per one base token as a decimal string. */
  readonly fairValues: ReadonlyMap<string, string>;
  readonly maxOpenCrosses: number;
  readonly passMs: number;
  readonly dryRun: boolean;
  readonly cluster: 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  return n;
}

function atoms(env: NodeJS.ProcessEnv, name: string): bigint {
  const raw = env[name];
  if (raw === undefined || !/^[0-9]{1,20}$/.test(raw)) throw new ConfigError(`${name} is required: an amount in atoms, digits only`);
  return BigInt(raw);
}

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MmConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new ConfigError(`${k} is required`);
    return v;
  };
  const apiUrl = need('API_URL').replace(/\/+$/, '');
  const rpcUrl = need('RPC_URL');
  const keypairPath = need('MM_KEYPAIR');
  const clusterRaw = env.NETWORK ?? 'devnet';
  if (clusterRaw !== 'devnet' && clusterRaw !== 'testnet' && clusterRaw !== 'mainnet-beta' && clusterRaw !== 'localnet') throw new ConfigError(`NETWORK must be devnet, testnet, mainnet-beta or localnet, got "${clusterRaw}"`);
  // The product is devnet-only today. Quoting real money needs a decision of its own, taken in writing.
  if (clusterRaw === 'mainnet-beta' && env.MM_ALLOW_MAINNET !== 'yes-i-understand-this-spends-real-money') throw new ConfigError('refusing to run on mainnet-beta: set MM_ALLOW_MAINNET=yes-i-understand-this-spends-real-money after the budget has been approved');

  const creators = new Set(list(env.MM_CREATORS));
  for (const c of creators) if (!isAddress(c)) throw new ConfigError(`MM_CREATORS contains a value that is not a Solana address: ${c.slice(0, 12)}`);
  const kinds = new Set<CrossKind>();
  for (const k of list(env.MM_KINDS ?? 'reopen,recurring,tender')) {
    if (!(KINDS as readonly string[]).includes(k)) throw new ConfigError(`MM_KINDS contains "${k}"; use ${KINDS.join(', ')}`);
    kinds.add(k as CrossKind);
  }
  const fairValues = new Map<string, string>();
  for (const pair of list(env.MM_FAIR_VALUES)) {
    const [mint, value] = pair.split('=');
    if (!mint || !isAddress(mint) || !value || !/^[0-9]+(\.[0-9]+)?$/.test(value)) throw new ConfigError(`MM_FAIR_VALUES entries look like <base mint>=<quote tokens per base token>, got "${pair.slice(0, 40)}"`);
    fairValues.set(mint, value);
  }
  const strategy: Strategy = {
    halfSpreadBps: int(env, 'MM_HALF_SPREAD_BPS', 200, 1, 5_000),
    levels: int(env, 'MM_LEVELS', 3, 1, 8),
    stepBps: int(env, 'MM_STEP_BPS', 100, 0, 2_000),
    quoteBudget: atoms(env, 'MM_QUOTE_BUDGET'),
    baseBudget: atoms(env, 'MM_BASE_BUDGET'),
    minSecondsLeft: int(env, 'MM_MIN_SECONDS_LEFT', 45, 0, 86_400),
  };
  try {
    validateStrategy(strategy);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  return {
    apiUrl,
    rpcUrl,
    keypairPath,
    sealSecretFile: env.MM_SEAL_SECRET_FILE || null,
    statePath: env.MM_STATE_FILE ?? 'marketmaker-state.json',
    logPath: env.MM_LOG_FILE || null,
    strategy,
    creators,
    kinds,
    fairValues,
    maxOpenCrosses: int(env, 'MM_MAX_OPEN_CROSSES', 3, 1, 50),
    passMs: int(env, 'MM_PASS_MS', 15_000, 1_000, 3_600_000),
    dryRun: env.MM_DRY_RUN === '1',
    cluster: clusterRaw,
  };
}
