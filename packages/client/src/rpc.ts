// A small JSON-RPC client for the few calls an Opening Cross client needs. Public RPC endpoints answer bursts with
// HTTP 429, so every call rides out 429 and brief upstream failures with backoff. A call that is safe to repeat is
// repeated; sending a transaction repeats the same signed bytes, whose signature is fixed, so a second send cannot
// double-spend.
import { ActionError } from './errors.js';
import { type RpcFailure, explainFailure } from './explain.js';
import { type HttpDeps, defaultSleep } from './http.js';

export type RpcOptions = HttpDeps & { url: string; attempts?: number };

export type RpcAccount = { data: Uint8Array; owner: string; lamports: bigint };
export type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };
export type SignatureStatus = { err: unknown; confirmationStatus: string } | null;
export type Simulation = { err: unknown; logs: string[]; unitsConsumed: number | null; explanation: string | null };

/** The cluster refused a request (as opposed to being unreachable): the message is the cluster's own words, explained. */
export class RpcRefused extends ActionError {
  constructor(message: string) {
    super(message, 'RPC_REFUSED');
  }
}

export type RpcClient = ReturnType<typeof createRpcClient>;

const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bytesToB64 = (b: Uint8Array): string => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

export function createRpcClient(opts: RpcOptions) {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = opts.attempts ?? 8;

  /** One JSON-RPC call; 429 and upstream failures are ridden out with backoff. */
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let json: { result?: T; error?: RpcFailure } = {};
    let status = 0;
    let unreachable = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await doFetch(opts.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        status = res.status;
        json = (await res.json().catch(() => ({ error: { message: `The RPC endpoint answered HTTP ${res.status}.` } }))) as typeof json;
      } catch {
        status = 0;
        json = { error: { message: 'The RPC endpoint could not be reached.' } };
      }
      const limited = status === 429 || json.error?.code === 429 || status === 0 || status === 502 || status === 503 || status === 504;
      // A refused connection is worth a few tries (a restarting proxy); a rate limit is worth many (it clears).
      if (status === 0) unreachable += 1;
      if (!limited || attempt >= attempts || unreachable >= 3) break;
      await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
    }
    if (json.error) {
      if (status === 429 || json.error.code === 429) throw new ActionError('The network endpoint is rate limiting this connection.', 'RPC_UNREACHABLE');
      if (status === 0) throw new ActionError('The network endpoint could not be reached.', 'RPC_UNREACHABLE');
      throw new RpcRefused(explainFailure(json.error) ?? json.error.message ?? 'The network refused the request.');
    }
    return json.result as T;
  }

  return {
    url: opts.url,
    call,

    /** The account at `address` at `confirmed`, or null if it does not exist. */
    async getAccount(address: string): Promise<RpcAccount | null> {
      const r = await call<{ value: { data: [string, string]; owner: string; lamports: number } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
      return r.value ? { data: b64ToBytes(r.value.data[0]), owner: r.value.owner, lamports: BigInt(r.value.lamports) } : null;
    },

    async getAccounts(addresses: readonly string[]): Promise<(RpcAccount | null)[]> {
      const out: (RpcAccount | null)[] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const r = await call<{ value: ({ data: [string, string]; owner: string; lamports: number } | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
        for (const v of r.value) out.push(v ? { data: b64ToBytes(v.data[0]), owner: v.owner, lamports: BigInt(v.lamports) } : null);
      }
      return out;
    },

    async balance(address: string): Promise<bigint> {
      return BigInt((await call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value);
    },

    async tokenBalance(tokenAccount: string): Promise<{ amount: bigint; decimals: number } | null> {
      try {
        const r = await call<{ value: { amount: string; decimals: number } }>('getTokenAccountBalance', [tokenAccount, { commitment: 'confirmed' }]);
        return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
      } catch (e) {
        if (e instanceof RpcRefused) return null;
        throw e;
      }
    },

    async latestBlockhash(): Promise<Lifetime> {
      const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
    },

    /** The cluster's clock in unix seconds (the time cross_core compares windows against), or this machine's clock if the cluster will not say. */
    async unixTime(): Promise<bigint> {
      try {
        const slot = await call<number>('getSlot', [{ commitment: 'confirmed' }]);
        const t = await call<number | null>('getBlockTime', [slot]);
        if (t !== null) return BigInt(t);
      } catch {
        // Fall through: a block time is a convenience for the countdown, never an input to a transaction.
      }
      return BigInt(Math.floor(Date.now() / 1000));
    },

    async send(wire: Uint8Array): Promise<string> {
      return call<string>('sendTransaction', [bytesToB64(wire), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    },

    async signatureStatus(signature: string): Promise<SignatureStatus> {
      const r = await call<{ value: SignatureStatus[] }>('getSignatureStatuses', [[signature]]);
      return r.value[0] ?? null;
    },

    /** Runs the transaction against the current state without sending it. The signatures are not checked, so an unsigned transaction can be simulated. */
    async simulate(wire: Uint8Array): Promise<Simulation> {
      const r = await call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
        bytesToB64(wire),
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
      ]);
      const logs = r.value.logs ?? [];
      return { err: r.value.err, logs, unitsConsumed: r.value.unitsConsumed ?? null, explanation: r.value.err ? explainFailure({ data: { logs, err: r.value.err } }) : null };
    },
  };
}
