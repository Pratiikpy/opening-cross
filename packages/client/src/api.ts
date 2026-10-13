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

/** The treasury actions `api.treasury.tx` builds. */
export type TreasuryAction =
  | 'init-ext' | 'propose' | 'vote' | 'reclaim-vote' | 'execute-proposal' | 'nav-redeem' | 'stake' | 'unstake' | 'deposit-distribution' | 'claim-distribution'
  | 'pay-round' | 'mark-missed' | 'release-tranche' | 'create-grant' | 'release-milestone' | 'expire-grant' | 'post-disclosure' | 'request-disclosure'
  | 'record-assignment' | 'sweep-unclaimed' | 'spend' | 'record-attested' | 'record-lapse' | 'trigger-liquidation' | 'redeem';

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

    // ---- the rules extension, the treasury extension and cross_settle (docs/api/W3A-rules-treasury-settle.md). They read the extended programs; a cross, wallet or
    // mint that has none of it gets an empty answer with a note.
    getRules: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/rules`, signal),
    getIndicative: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/indicative`, signal),
    getEnding: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/ending`, signal),
    getChallenges: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/challenges`, signal),
    getProofWithDraws: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/proof/draws`, signal),
    getSettlement: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/settlement`, signal),
    ownerLockups: (owner: string, o: { cross?: string } = {}, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/owners/${encodeURIComponent(owner)}/lockups${q(o)}`, signal),
    getHalt: (baseMint: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/halts/${encodeURIComponent(baseMint)}`, signal),
    getPrintFeed: (baseMint: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/feeds/${encodeURIComponent(baseMint)}`, signal),
    getSeries: (series: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/series/${encodeURIComponent(series)}`, signal),
    listSeries: (o: { authority?: string } = {}, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/series${q(o)}`, signal),
    // ---- opening a market for a cleared cross, the Meteora programs around it, and issuer neutrality (docs/api/W3E-markets-keeper-neutrality.md). Reads of chain state.
    getVenues: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/venues`, signal),
    getAlphaVault: (cross: string, o: { owner?: string } = {}, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/alpha-vault${q(o)}`, signal),
    getMetLockEscrow: (escrow: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/metlock/escrows/${encodeURIComponent(escrow)}`, signal),
    getFeeShareVault: (base: string, mint: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/fee-share/${encodeURIComponent(base)}/${encodeURIComponent(mint)}`, signal),
    getArbiter: (signal?: AbortSignal) => read<Record<string, unknown>>('/v1/arbiter', signal),
    getChallengeState: (cross: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/crosses/${encodeURIComponent(cross)}/challenge-state`, signal),
    /** Which release of cross_core, treasury and cross_settle the cluster runs (null: could not be told). The extension instructions are not on devnet until docs/HUMAN_TASKS.md H27. */
    getPrograms: (signal?: AbortSignal) => read<Record<string, unknown>>('/v1/programs', signal),
    checkRules: (b: ActionBody) => fetchJson<Record<string, unknown>>(`${base}/v1/rules/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, deps).then((r) => (r.ok ? r.data : Promise.reject(failure(r)))),
    treasury: {
      terms: (treasury: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/ext`, signal),
      proposals: (treasury: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/proposals`, signal),
      proposal: (treasury: string, id: string, o: { voter?: string } = {}, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/proposals/${encodeURIComponent(id)}${q(o)}`, signal),
      position: (treasury: string, owner: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/positions/${encodeURIComponent(owner)}`, signal),
      grants: (treasury: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/grants`, signal),
      rounds: (treasury: string, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/rounds`, signal),
      events: (treasury: string, o: { name?: string; limit?: number } = {}, signal?: AbortSignal) => read<Record<string, unknown>>(`/v1/treasuries/${encodeURIComponent(treasury)}/events${q(o)}`, signal),
      /** An unsigned transaction for one treasury action: `init-ext`, `propose`, `vote`, `reclaim-vote`, `execute-proposal`, `nav-redeem`, `stake`, `unstake`, `deposit-distribution`, `claim-distribution`, `pay-round`, `mark-missed`, `release-tranche`, `create-grant`, `release-milestone`, `expire-grant`, `post-disclosure`, `request-disclosure`, `record-assignment`, `sweep-unclaimed`, `spend`, `record-attested`, `record-lapse`, `trigger-liquidation`, `redeem`. */
      tx: (treasury: string, action: TreasuryAction, b: ActionBody) => build(`/v1/treasuries/${encodeURIComponent(treasury)}/tx/${action}`, b),
    },

    tx: {
      placeOrderExt: (b: ActionBody) => build('/v1/tx/place-order-ext', b),
      createCrossRuled: (b: ActionBody) => build('/v1/tx/create-cross-ruled', b),
      settleExt: (b: ActionBody) => build('/v1/tx/settle-ext', b),
      drawBegin: (b: ActionBody) => build('/v1/tx/draw-begin', b),
      drawFinish: (b: ActionBody) => build('/v1/tx/draw-finish', b),
      releaseLocked: (b: ActionBody) => build('/v1/tx/release-locked', b),
      pushRefunds: (b: ActionBody) => build('/v1/tx/push-refunds', b),
      closeApplicant: (b: ActionBody) => build('/v1/tx/close-applicant', b),
      challengeInsider: (b: ActionBody) => build('/v1/tx/challenge-insider', b),
      resolveChallenge: (b: ActionBody) => build('/v1/tx/resolve-challenge', b),
      expireChallenge: (b: ActionBody) => build('/v1/tx/expire-challenge', b),
      setArbiter: (b: ActionBody) => build('/v1/tx/set-arbiter', b),
      initHaltState: (b: ActionBody) => build('/v1/tx/init-halt-state', b),
      setHalt: (b: ActionBody) => build('/v1/tx/set-halt', b),
      setCorporateAction: (b: ActionBody) => build('/v1/tx/set-corporate-action', b),
      syncPause: (b: ActionBody) => build('/v1/tx/sync-pause', b),
      observePrice: (b: ActionBody) => build('/v1/tx/observe-price', b),
      initPrintFeed: (b: ActionBody) => build('/v1/tx/init-print-feed', b),
      setFeedPublishers: (b: ActionBody) => build('/v1/tx/set-feed-publishers', b),
      createSeries: (b: ActionBody) => build('/v1/tx/create-series', b),
      spawnNext: (b: ActionBody) => build('/v1/tx/spawn-next', b),
      setSeriesActive: (b: ActionBody) => build('/v1/tx/set-series-active', b),
      seriesWithdraw: (b: ActionBody) => build('/v1/tx/series-withdraw', b),
      claimPartnerFee: (b: ActionBody) => build('/v1/tx/claim-partner-fee', b),
      withdrawPartnerSurplus: (b: ActionBody) => build('/v1/tx/withdraw-partner-surplus', b),
      withdrawPartnerMigrationFee: (b: ActionBody) => build('/v1/tx/withdraw-partner-migration-fee', b),
      claimPartnerPoolCreationFee: (b: ActionBody) => build('/v1/tx/claim-partner-pool-creation-fee', b),
      claimPolFees: (b: ActionBody) => build('/v1/tx/claim-pol-fees', b),
      // Opening a market (`transactions` may hold more than one: send them in order, each after the one before has landed).
      openDbcPool: (b: ActionBody) => build('/v1/tx/open-dbc-pool', b),
      bindDbcMint: (b: ActionBody) => build('/v1/tx/bind-dbc-mint', b),
      seedDammV2: (b: ActionBody) => build('/v1/tx/seed-damm-v2', b),
      openDlmmPair: (b: ActionBody) => build('/v1/tx/open-dlmm-pair', b),
      seedRaydiumCpmm: (b: ActionBody) => build('/v1/tx/seed-raydium-cpmm', b),
      // Meteora's Alpha Vault, Met Lock and Dynamic Fee Sharing programs.
      alphaVaultInit: (b: ActionBody) => build('/v1/tx/alpha-vault-init', b),
      alphaVaultDeposit: (b: ActionBody) => build('/v1/tx/alpha-vault-deposit', b),
      alphaVaultFill: (b: ActionBody) => build('/v1/tx/alpha-vault-fill', b),
      alphaVaultClaim: (b: ActionBody) => build('/v1/tx/alpha-vault-claim', b),
      alphaVaultWithdrawRemaining: (b: ActionBody) => build('/v1/tx/alpha-vault-withdraw-remaining', b),
      metlockCreate: (b: ActionBody) => build('/v1/tx/metlock-create', b),
      metlockClaim: (b: ActionBody) => build('/v1/tx/metlock-claim', b),
      feeShareCreate: (b: ActionBody) => build('/v1/tx/fee-share-create', b),
      feeShareFund: (b: ActionBody) => build('/v1/tx/fee-share-fund', b),
      feeShareClaim: (b: ActionBody) => build('/v1/tx/fee-share-claim', b),
      feeShareTransferPosition: (b: ActionBody) => build('/v1/tx/fee-share-transfer-position', b),
      feeShareFundFromDamm: (b: ActionBody) => build('/v1/tx/fee-share-fund-from-damm', b),
      createGreenshoe: (b: ActionBody) => build('/v1/tx/create-greenshoe', b),
      deployGreenshoeBid: (b: ActionBody) => build('/v1/tx/deploy-greenshoe-bid', b),
      settleGreenshoeLevel: (b: ActionBody) => build('/v1/tx/settle-greenshoe-level', b),
      finishGreenshoe: (b: ActionBody) => build('/v1/tx/finish-greenshoe', b),
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
