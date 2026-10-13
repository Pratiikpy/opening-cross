// A JSON-RPC client over several endpoints. A call goes to the best endpoint; if that one is rate limiting, down or
// returns an "unhealthy node" error, the same call goes to the next. A real answer, including a JSON-RPC error that is the
// cluster telling you your request is wrong (a failed simulation, a missing account), is returned as it is: trying another
// endpoint would only repeat it.
import { EndpointPool, type PoolOptions } from './pool.js';

export class RpcCallError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly endpoint: string | null,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

/** Every endpoint was tried and none could answer. `attempts` says what each one did. */
export class AllEndpointsFailed extends Error {
  constructor(
    readonly method: string,
    readonly attempts: { endpoint: string; problem: string }[],
  ) {
    super(`${method}: no endpoint could answer (${attempts.map((a) => `${host(a.endpoint)}: ${a.problem}`).join('; ')})`);
    this.name = 'AllEndpointsFailed';
  }
}

export interface FailoverOptions extends PoolOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt timeout. Default 15 s. */
  timeoutMs?: number;
  /** Methods that must reach exactly one endpoint at a time are all of them but sends, which `land` broadcasts. Reads may be hedged: if the first endpoint has not answered after this long, ask the second too and take the first answer. 0 disables. Default 0. */
  hedgeAfterMs?: number;
  /** After every endpoint has refused, wait and go round again this many times. Default 1. */
  rounds?: number;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// JSON-RPC codes by which a node says "I am the problem" rather than "your request is".
const NODE_UNHEALTHY = new Set([-32005, -32004, -32007, -32009, -32014, -32016]);
const RATE_LIMIT_CODES = new Set([429, -32029]);

type Raw = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class FailoverRpc {
  readonly pool: EndpointPool;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly hedgeAfterMs: number;
  private readonly rounds: number;
  private readonly now: () => number;

  constructor(urls: readonly string[], opts: FailoverOptions = {}) {
    this.pool = new EndpointPool(urls, opts);
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.hedgeAfterMs = opts.hedgeAfterMs ?? 0;
    this.rounds = Math.max(1, opts.rounds ?? 1);
    this.now = opts.now ?? Date.now;
  }

  /** One attempt at one endpoint. Returns the raw reply, or throws a classified problem the caller records. */
  private async attempt(url: string, body: string): Promise<{ raw: Raw; ms: number }> {
    const started = this.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
    } catch (e) {
      throw { kind: 'failed' as const, reason: ctl.signal.aborted ? `no answer in ${this.timeoutMs} ms` : e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      throw { kind: 'rate-limited' as const, retryAfterMs: ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined };
    }
    if (res.status >= 500 || res.status === 408) throw { kind: 'failed' as const, reason: `HTTP ${res.status}` };
    let raw: Raw;
    try {
      raw = (await res.json()) as Raw;
    } catch {
      throw { kind: 'failed' as const, reason: `HTTP ${res.status} with a body that is not JSON` };
    }
    if (res.status === 401 || res.status === 403) throw { kind: 'failed' as const, reason: `HTTP ${res.status}: this endpoint wants credentials we did not send` };
    if (res.status >= 400 && !raw?.error) throw { kind: 'failed' as const, reason: `HTTP ${res.status}` };
    const code = raw.error?.code;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) throw { kind: 'rate-limited' as const };
    // A provider refusing us for lack of a key is the endpoint's problem, not an answer to the question asked.
    if (raw.error && /unauthori[sz]ed|api[ -]?key|forbidden|authenticate/i.test(raw.error.message)) throw { kind: 'failed' as const, reason: raw.error.message.slice(0, 80) };
    if (code !== undefined && NODE_UNHEALTHY.has(code)) throw { kind: 'failed' as const, reason: raw.error!.message };
    return { raw, ms: this.now() - started };
  }

  private async tryEndpoint(url: string, body: string, problems: { endpoint: string; problem: string }[]): Promise<Raw | null> {
    try {
      const { raw, ms } = await this.attempt(url, body);
      this.pool.record(url, { kind: 'ok', ms });
      return raw;
    } catch (e) {
      const o = e as { kind: 'rate-limited'; retryAfterMs?: number } | { kind: 'failed'; reason: string };
      if (o && typeof o === 'object' && 'kind' in o) {
        this.pool.record(url, o);
        problems.push({ endpoint: url, problem: o.kind === 'rate-limited' ? 'rate limited' : o.reason });
        return null;
      }
      throw e;
    }
  }

  /** The reply to a JSON-RPC call, from the best endpoint that can answer. */
  async request(method: string, params: unknown[] = []): Promise<Raw> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const problems: { endpoint: string; problem: string }[] = [];
    for (let round = 1; round <= this.rounds; round++) {
      const order = this.pool.order();
      for (let i = 0; i < order.length; i++) {
        const url = order[i]!;
        const next = order[i + 1];
        let raw: Raw | null;
        if (this.hedgeAfterMs > 0 && next && method !== 'sendTransaction') {
          raw = await this.hedged(url, next, body, problems);
          i += 1; // both were tried
        } else {
          raw = await this.tryEndpoint(url, body, problems);
        }
        if (raw) return raw;
      }
      if (round < this.rounds) await this.sleep(Math.min(5_000, 500 * 2 ** (round - 1)));
    }
    throw new AllEndpointsFailed(method, problems);
  }

  private async hedged(first: string, second: string, body: string, problems: { endpoint: string; problem: string }[]): Promise<Raw | null> {
    const a = this.tryEndpoint(first, body, problems);
    const winner = await Promise.race([a, this.sleep(this.hedgeAfterMs).then(() => 'late' as const)]);
    if (winner !== 'late' && winner !== null) return winner;
    const b = this.tryEndpoint(second, body, problems);
    const results = await Promise.all([a, b]);
    return results.find((r) => r !== null) ?? null;
  }

  /** The `result` of a call. A JSON-RPC error that is the cluster's answer becomes an RpcCallError. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const raw = await this.request(method, params);
    if (raw.error) throw new RpcCallError(raw.error.message, raw.error.code, null, raw.error.data);
    return raw.result as T;
  }

  /** A `fetch` that ignores the URL it is given and answers through the pool, for code that takes a fetch (such as @opening-cross/client's `createRpcClient({ url, fetch })`). */
  asFetch(): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { method: string; params?: unknown[]; id?: unknown };
      try {
        const raw = await this.request(parsed.method, parsed.params ?? []);
        return new Response(JSON.stringify({ ...raw, id: parsed.id ?? raw.id }), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        if (e instanceof AllEndpointsFailed) {
          const limited = e.attempts.length > 0 && e.attempts.every((a) => a.problem === 'rate limited');
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, error: { code: limited ? 429 : -32603, message: e.message } }), { status: limited ? 429 : 503 });
        }
        throw e;
      }
    }) as typeof fetch;
  }

  /** The same call to every endpoint that is not cooling down, all at once. Used to send a transaction by every route, since any one of them may be the leader's best path. */
  async broadcast(method: string, params: unknown[] = []): Promise<{ endpoint: string; reply: Raw | null; problem: string | null }[]> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const t = this.now();
    const live = this.pool.snapshot().filter((s) => s.cooldownUntil <= t).map((s) => s.url);
    const targets = live.length ? live : this.pool.urls;
    return Promise.all(
      targets.map(async (endpoint) => {
        const problems: { endpoint: string; problem: string }[] = [];
        const reply = await this.tryEndpoint(endpoint, body, problems);
        return { endpoint, reply, problem: problems[0]?.problem ?? null };
      }),
    );
  }

  /** Asks every endpoint for its slot and tells the pool which ones are behind. Returns the slots seen. */
  async probe(): Promise<Map<string, number | null>> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] });
    const slots = new Map<string, number | null>();
    await Promise.all(
      this.pool.urls.map(async (url) => {
        const problems: { endpoint: string; problem: string }[] = [];
        const raw = await this.tryEndpoint(url, body, problems);
        slots.set(url, raw && typeof raw.result === 'number' ? raw.result : null);
      }),
    );
    this.pool.recordSlots(slots);
    return slots;
  }
}
