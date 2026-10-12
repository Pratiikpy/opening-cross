// A typed client for the Opening Cross REST API (services/api). Reads return data or throw an ActionError carrying the
// API's own sentence; builders return unsigned transactions and never a signature.
import { ActionError, type ActionErrorCode } from './errors.js';
import { type Fetched, type HttpDeps, fetchJson } from './http.js';
import type { BookResponse, BuiltAction, CrossDetail, CrossStateName, CrossSummary, FairnessProofView, OrderLookup, OwnerOrder, Side, Stats, UnsignedTransaction } from './types.js';

export type ApiOptions = HttpDeps & {
  baseUrl: string;
  /** How often a safe request is attempted before giving up. */
  attempts?: number;
};

export type ActionBody = Record<string, unknown>;

/** The intent a best-execution quote is asked for. Amounts are decimal strings of atoms. */
export type RouteIntent = { cross: string; side: Side; quantity: string; limitPrice?: string };

/** A best-execution answer, or a typed statement that this deployment does not offer one. */
export type RouteQuote = { status: 'ready'; report: Record<string, unknown> } | { status: 'unavailable'; reason: string };

export type ApiClient = ReturnType<typeof createApiClient>;

function codeFor(status: number): ActionErrorCode {
  if (status === 0) return 'API_UNREACHABLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400) return 'INVALID_INPUT';
  return 'API_REFUSED';
}

function failure(r: Extract<Fetched<unknown>, { ok: false }>): ActionError {
  if (r.status === 0) return new ActionError('The Opening Cross API could not be reached. Nothing was signed.', 'API_UNREACHABLE');
  if (r.status === 429) return new ActionError(`The API is receiving a lot of requests from this connection. Nothing was signed; try again in ${r.retryAfterSeconds ?? 10} seconds.`, 'RATE_LIMITED');
  if (r.status === 503) return new ActionError('The network endpoint behind the API is busy. Nothing was signed; try again in a few seconds.', 'API_REFUSED');
  return new ActionError(r.error, codeFor(r.status));
}

export function createApiClient(opts: ApiOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const deps = { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), attempts: opts.attempts ?? 4 };

  async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await fetchJson<T>(`${base}${path}`, { ...(signal ? { signal } : {}), cache: 'no-store' }, deps);
    if (!r.ok) throw failure(r);
    return r.data;
  }

  async function build(path: string, body: ActionBody): Promise<BuiltAction> {
    const r = await fetchJson<Record<string, unknown> & { transactions?: UnsignedTransaction[]; transaction?: string; signers?: string[] }>(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      { ...deps, attempts: Math.max(deps.attempts, 5) },
    );
    if (!r.ok) throw failure(r);
    const { transactions: many, transaction, signers, ...extra } = r.data;
    const transactions = many ?? (transaction ? [{ transaction, signers: signers ?? [] }] : []);
    return { transactions, extra };
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const text = s.toString();
    return text ? `?${text}` : '';
  };

  return {
    baseUrl: base,
    health: (signal?: AbortSignal) => read<{ ok: boolean; indexedSlot: string | null; recentDriftAlerts: number; indexer: { caughtUpToSlot: string; secondsSinceLastCaughtUp: number } | null }>('/v1/health', signal),
    stats: (signal?: AbortSignal) => read<Stats>('/v1/stats', signal),
    listCrosses: async (o: { state?: CrossStateName; limit?: number } = {}, signal?: AbortSignal) => (await read<{ crosses: CrossSummary[] }>(`/v1/crosses${q(o)}`, signal)).crosses,
    getCross: (address: string, signal?: AbortSignal) => read<CrossDetail>(`/v1/crosses/${encodeURIComponent(address)}`, signal),
    getBook: (address: string, signal?: AbortSignal) => read<BookResponse>(`/v1/crosses/${encodeURIComponent(address)}/book`, signal),
    getProof: (address: string, signal?: AbortSignal) => read<FairnessProofView>(`/v1/crosses/${encodeURIComponent(address)}/proof`, signal),
    crossOrders: async (address: string, signal?: AbortSignal) => (await read<{ orders: Omit<OwnerOrder, 'cross_address'>[] }>(`/v1/crosses/${encodeURIComponent(address)}/orders`, signal)).orders,
    ownerOrders: async (owner: string, signal?: AbortSignal) => (await read<{ orders: OwnerOrder[] }>(`/v1/owners/${encodeURIComponent(owner)}/orders`, signal)).orders,
    orders: async (addresses: readonly string[], signal?: AbortSignal) => (addresses.length === 0 ? [] : (await read<{ orders: OrderLookup[] }>(`/v1/orders${q({ addresses: addresses.join(',') })}`, signal)).orders),

    /** Streams the API's event feed for one cross (or all crosses). Returns a function that closes the stream. */
    subscribe(cross: string | null, onEvent: (event: { type: string; [k: string]: unknown }) => void, WebSocketImpl: typeof WebSocket | undefined = globalThis.WebSocket): () => void {
      if (!WebSocketImpl) return () => {};
      const url = `${base.replace(/^http/, 'ws')}/v1/stream${cross ? q({ cross }) : ''}`;
      let ws: WebSocket | null = null;
      try {
        ws = new WebSocketImpl(url);
        ws.onmessage = (m) => {
          try {
            onEvent(JSON.parse(String(m.data)) as { type: string });
          } catch {
            // A frame that is not JSON is not ours.
          }
        };
      } catch {
        ws = null;
      }
      return () => ws?.close();
    },

    /**
     * The best-execution comparison for one order, when the deployment offers the router. A deployment without it answers 404 or
     * 501 and this returns `unavailable`; a refusal of the request itself (bad address, closed cross) is still thrown.
     */
    async routeQuote(intent: RouteIntent, signal?: AbortSignal): Promise<RouteQuote> {
      const r = await fetchJson<Record<string, unknown>>(`${base}/v1/route/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent), ...(signal ? { signal } : {}) }, deps);
      if (r.ok) return { status: 'ready', report: r.data };
      if (r.status === 404 || r.status === 501) return { status: 'unavailable', reason: 'This deployment does not offer best-execution quotes.' };
      throw failure(r);
    },

    tx: {
      placeOrder: (b: ActionBody) => build('/v1/tx/place-order', b),
      cancel: (b: ActionBody) => build('/v1/tx/cancel', b),
      reveal: (b: ActionBody) => build('/v1/tx/reveal', b),
      settle: (b: ActionBody) => build('/v1/tx/settle', b),
      claim: (b: ActionBody) => build('/v1/tx/claim', b),
      finalize: (b: ActionBody) => build('/v1/tx/finalize', b),
      initShards: (b: ActionBody) => build('/v1/tx/init-shards', b),
      createCross: (b: ActionBody) => build('/v1/tx/create-cross', b),
    },
  };
}
