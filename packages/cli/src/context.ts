// How a command learns where the cluster is, which API to ask, which key signs and where sealed bids are kept.
// Everything comes from a flag first, then an environment variable, then a documented default; nothing is read from a
// file the user did not name.
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ApiClient,
  ActionError,
  type ClientStore,
  type RpcClient,
  type TxBuilder,
  apiTxBuilder,
  createApiClient,
  createRpcClient,
  localTxBuilder,
} from '@opening-cross/client';
import { type KeypairSigner, fileStore, loadKeypairSigner, signerFromKeypairBytes } from '@opening-cross/client/node';

export type Io = { out: (line: string) => void; err: (line: string) => void };

export type Env = Record<string, string | undefined>;

export const CLUSTERS = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

const DEFAULT_RPC: Record<Cluster, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

/** The flags every command shares. */
export type Globals = {
  cluster?: string | undefined;
  rpc?: string | undefined;
  api?: string | undefined;
  keypair?: string | undefined;
  vault?: string | undefined;
  build?: string | undefined;
  json?: boolean | undefined;
  'dry-run'?: boolean | undefined;
};

export type Runtime = {
  io: Io;
  env: Env;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock for relative times, in milliseconds. */
  now?: () => number;
  /** Aborted when the user interrupts (Ctrl+C); long-running commands such as `watch` stop and exit cleanly. */
  signal?: AbortSignal;
};

export type Context = {
  cluster: Cluster;
  json: boolean;
  dryRun: boolean;
  rpc: RpcClient;
  io: Io;
  runtime: Runtime;
  /** The API client; throws an INVALID_INPUT error naming the flag when no API was configured. */
  api(): ApiClient;
  hasApi: boolean;
  /** The key that signs. Throws an INVALID_INPUT error when none was given or the file is unusable. */
  signer(): Promise<KeypairSigner>;
  store(): ClientStore;
  builder(): TxBuilder;
};

function usage(message: string): never {
  throw new ActionError(message, 'INVALID_INPUT');
}

export function resolveContext(g: Globals, rt: Runtime): Context {
  const clusterText = g.cluster ?? rt.env.OPENING_CROSS_CLUSTER ?? 'devnet';
  if (!(CLUSTERS as readonly string[]).includes(clusterText)) usage(`--cluster must be one of ${CLUSTERS.join(', ')} (got "${clusterText}").`);
  const cluster = clusterText as Cluster;
  const rpcUrl = g.rpc ?? rt.env.OPENING_CROSS_RPC ?? DEFAULT_RPC[cluster];
  if (!/^https?:\/\//.test(rpcUrl)) usage(`--rpc must be an http(s) URL (got "${rpcUrl}").`);
  const apiUrl = g.api ?? rt.env.OPENING_CROSS_API;
  if (apiUrl !== undefined && !/^https?:\/\//.test(apiUrl)) usage(`--api must be an http(s) URL (got "${apiUrl}").`);
  const build = g.build ?? 'local';
  if (build !== 'local' && build !== 'api') usage(`--build must be "local" or "api" (got "${build}").`);

  const deps = { ...(rt.fetch ? { fetch: rt.fetch } : {}), ...(rt.sleep ? { sleep: rt.sleep } : {}) };
  const rpc = createRpcClient({ url: rpcUrl, ...deps });
  let api: ApiClient | null = null;
  let signer: Promise<KeypairSigner> | null = null;
  let store: ClientStore | null = null;

  const ctx: Context = {
    cluster,
    json: g.json === true,
    dryRun: g['dry-run'] === true,
    rpc,
    io: rt.io,
    runtime: rt,
    hasApi: apiUrl !== undefined,
    api() {
      if (apiUrl === undefined) usage('This command needs the Opening Cross API: pass --api <url> or set OPENING_CROSS_API.');
      return (api ??= createApiClient({ baseUrl: apiUrl, ...deps }));
    },
    signer() {
      return (signer ??= (async () => {
        const path = g.keypair ?? rt.env.OPENING_CROSS_KEYPAIR;
        const inline = rt.env.OPENING_CROSS_SECRET_KEY;
        if (path) return loadKeypairSigner(path);
        if (inline) return signerFromKeypairBytes(inline, 'OPENING_CROSS_SECRET_KEY');
        return usage('This command signs a transaction: pass --keypair <file> (a Solana CLI keypair file) or set OPENING_CROSS_KEYPAIR to its path. This tool never creates or stores keys.');
      })());
    },
    store() {
      return (store ??= fileStore(g.vault ?? rt.env.OPENING_CROSS_VAULT ?? join(homedir(), '.opening-cross', `sealed-bids-${cluster}.json`)));
    },
    builder() {
      if (build === 'api') return apiTxBuilder(ctx.api());
      return localTxBuilder(rpc);
    },
  };
  return ctx;
}
