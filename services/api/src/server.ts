// Opening Cross API.
//
// Reads: the indexer's tables answer lists and history; anything a user acts on (a cross's state,
// clearing, an order) is read from chain in the same request, so the API never shows a stale
// state as current. Writes: unsigned transactions only (see tx.ts). Stream: every ingested event,
// pushed over WebSocket as the indexer commits it.
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, ORDER_DISCRIMINATOR, OrderSide, getCrossDecoder, getOrderDecoder } from '@opening-cross/sdk';
import { referenceClear, verifyCross } from '@opening-cross/verifier';
import { type DexQuote, type Intent, bestExecution, loadBook, quoteCross, quoteJupiter } from '@opening-cross/router';
import { anchorFor, getInputs, getPromise, latestForCross, records, samples } from '@opening-cross/promiser';
import { PROMISE_SCHEMA, report as accuracyReport } from '@opening-cross/promises';
import { classifyMint, loadBundledBook, observeVia } from '@opening-cross/authenticity';
import { groupObservations } from '@opening-cross/premium';
import { coverage as premiumCoverage, latestPerTicker, observationsSince } from '@opening-cross/premium-service';
import { createFactsLoader, executionQuality, externalFlow, fairness as fairnessReport, crossFairness } from './metrics.js';
import { type RateLimit, createLimiter } from './rate-limit.js';
import { createSafety, gate } from './safety.js';
import { rankVenues } from './venues.js';
import { recentReplays, replayRow } from './replay.js';
import { type Lifetime, RequestError, cancelTx, claimTx, createCrossTxs, finalizeTx, initShardsTxs, placeOrderTx, revealTx, settleTxs } from './tx.js';

export type ChainAccount = { data: Uint8Array; owner: Address };

export type ApiDeps = {
  db: pg.Pool;
  /** Reads an account with its owning program, or null if it does not exist. */
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Cluster the indexer follows (`devnet`, `mainnet-beta`, `localnet`), reported with every total. */
  network?: string;
  /** Public key that signs promises (the promiser's key); promises by any other key are not ours. */
  promiseSigner?: string;
  /**
   * Wallets we operate (OWN_WALLETS), excluded from the external-flow scorecard on top of each
   * cross's own creator, proceeds recipient, integrator and fee recipient. Empty when unset.
   */
  ownWallets?: ReadonlySet<string>;
  /** Read the immutable fields of every indexed cross from chain in the background at start, so the first metrics request is not the slow one. */
  warmMetrics?: boolean;
  /** Allowed browser origins; default any. */
  corsOrigins?: string[];
  /** Per-address request limit; omit to leave the API unlimited (the tests do). */
  rateLimit?: RateLimit;
  /** Trust X-Forwarded-For from the reverse proxy in front of the API, so the limiter sees client addresses. */
  trustProxy?: boolean;
  /** A dedicated connection for LISTEN; the API owns it once passed. */
  listen?: () => Promise<pg.Client>;
  /** Live DEX quote for /v1/router/quote; defaults to the router package's Jupiter adapter. Tests inject one. */
  dexQuote?: (p: { baseMint: Address; quoteMint: Address; intent: Intent }) => Promise<DexQuote>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Cache lifetime for mint safety verdicts in ms (default 30 000) and read attempts before a 429 is surfaced (default 4). */
  safety?: { ttlMs?: number; attempts?: number; sleep?: (ms: number) => Promise<void> };
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

// ---- input parsing: every field is validated before any chain read or transaction build.
const U64_MAX = (1n << 64n) - 1n;
function address(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
function u64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s) || BigInt(s) > U64_MAX) throw new RequestError(400, `${field} must be an unsigned 64-bit integer (decimal string)`);
  return BigInt(s);
}
function int(v: unknown, field: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new RequestError(400, `${field} must be an integer in [0, ${max}]`);
  return v;
}
function hex32(v: unknown, field: string): Uint8Array {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) throw new RequestError(400, `${field} must be 32 bytes of hex`);
  return Uint8Array.from(Buffer.from(v, 'hex'));
}
function side(v: unknown): OrderSide {
  if (v === 'buy') return OrderSide.Buy;
  if (v === 'sell') return OrderSide.Sell;
  throw new RequestError(400, 'side must be "buy" or "sell"');
}
function body(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'request body must be a JSON object');
  return v as Record<string, unknown>;
}
const opt = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === undefined || v === null ? null : f(v));

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable'] as const;

export async function buildServer(d: ApiDeps) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ...(d.trustProxy ? { trustProxy: true } : {}) });
  if (d.rateLimit) {
    const limiter = createLimiter({ exempt: ['/v1/health'], ...d.rateLimit });
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return;
      const verdict = limiter.check(req.ip, req.url.split('?')[0] ?? req.url);
      if (!verdict.allowed) {
        reply.header('retry-after', String(verdict.retryAfterSeconds));
        return send(reply, { error: 'too many requests from this address; retry in ' + verdict.retryAfterSeconds + ' s' }, 429);
      }
    });
  }
  // Browsers call the API directly (wallet flows). It holds no credentials and every write is an
  // unsigned transaction, so any origin may read it unless CORS_ORIGINS narrows the list.
  await app.register(fastifyCors, { origin: d.corsOrigins ?? '*', methods: ['GET', 'POST'] });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RequestError) return send(reply, { error: err.message, ...err.detail }, err.status);
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return send(reply, { error: e.message ?? 'bad request' }, e.statusCode);
    // The caller only sees a generic message; the operator needs the cause (an RPC that kept answering 429, a database error).
    // A cluster endpoint that is rate limiting or unreachable is the API's upstream, not a fault in the request or the API.
    const upstream = /\b429\b|HTTP error|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${String(err)} ${JSON.stringify((err as { context?: unknown }).context ?? {})}`);
    console.error(JSON.stringify({ at: new Date().toISOString(), status: upstream ? 503 : 500, method: req.method, url: req.url.split('?')[0], error: String(err) }));
    if (upstream) return send(reply.header('retry-after', '5'), { error: 'the Solana RPC endpoint is busy or unreachable; retry in a few seconds' }, 503);
    return send(reply, { error: 'internal error' }, 500);
  });
  app.setNotFoundHandler((_req, reply) => send(reply, { error: 'no such route' }, 404));

  // Only accounts owned by cross_core and carrying the right discriminator are ever decoded:
  // anyone can create an account whose bytes look like a cross under another program.
  const owned = (acct: ChainAccount | null, disc: Uint8Array) =>
    acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS && acct.data.length >= 8 && disc.every((b, i) => acct.data[i] === b) ? acct.data : null;
  const fetchOwned = async (a: Address) => {
    const acct = await d.account(a);
    return acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS ? acct.data : null;
  };

  // Mint safety (packages/token-safety): cached, retried on 429, shared by the token route, the cross route,
  // create-cross and the router.
  const safety = createSafety({ account: d.account, ...(d.clock && { now: () => d.clock!() * 1000 }), ...d.safety });

  async function crossView(a: Address) {
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    const data = owned(acct, CROSS_DISCRIMINATOR as Uint8Array);
    if (!data) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return { address: a, data: getCrossDecoder().decode(data) };
  }

  function present(address: Address, c: ReturnType<ReturnType<typeof getCrossDecoder>['decode']>) {
    const clearing = c.clearing.__option === 'Some' ? c.clearing.value : null;
    return {
      address,
      state: STATE[c.state],
      disclosure: c.disclosure === Disclosure.Sealed ? 'sealed' : 'open',
      creator: c.creator,
      baseMint: c.baseBound ? c.baseMint : null,
      quoteMint: c.quoteMint,
      window: { openTs: c.openTs, closeTs: c.closeTs, revealEndTs: c.revealEndTs },
      grid: { minPrice: c.minPrice, tick: c.tick, ticks: c.ticks, priceScale: c.priceScale },
      decimals: { base: c.baseDecimals, quote: c.quoteDecimals },
      supplyMode: ['escrow', 'mint', 'deferred-mint'][c.supplyMode],
      kind: ['launch', 'reopen', 'tender', 'recurring'][c.kind],
      settlement: { settleDeadlineTs: c.settleDeadlineTs, baseBound: c.baseBound },
      fees: { protocolBps: c.protocolFeeBps, integratorBps: c.integratorFeeBps, integrator: c.integrator },
      orders: { total: c.ordersTotal, open: c.ordersOpen, max: c.maxOrders },
      clearing: clearing && { price: clearing.price, matched: clearing.matched, rationed: ['none', 'buy', 'sell'][clearing.rationed] },
      noPrintReason: c.noPrintReason.__option === 'Some' ? NO_PRINT[c.noPrintReason.value] : null,
      gateMint: c.gateMint.__option === 'Some' ? c.gateMint.value : null,
      oracleGuard: c.oracle.__option === 'Some',
    };
  }

  // ---------------------------------------------------------------- reads
  app.get('/v1/health', async (_req, reply) => {
    const { rows } = await d.db.query(`SELECT (SELECT max(last_slot) FROM cursors) AS slot, (SELECT count(*)::int FROM reconciliation_alerts WHERE at > now() - interval '1 hour') AS alerts,
      (SELECT head_slot FROM indexer_heartbeat WHERE id = 1) AS head, (SELECT floor(extract(epoch FROM now() - polled_at))::int FROM indexer_heartbeat WHERE id = 1) AS age`);
    const ok = rows[0].alerts === 0;
    // The indexer's heartbeat: the finalized slot it had caught up to and how many seconds ago. Null until the first poll finishes.
    const indexer = rows[0].age === null ? null : { caughtUpToSlot: rows[0].head, secondsSinceLastCaughtUp: rows[0].age };
    return send(reply, { ok, indexedSlot: rows[0].slot, recentDriftAlerts: rows[0].alerts, indexer }, ok ? 200 : 503);
  });

  // Protocol-wide totals for the landing page. Every figure is computed from indexed events; the
  // network the indexer follows is reported with them so a devnet figure is never shown as mainnet.
  app.get('/v1/stats', async (_req, reply) => {
    const { rows } = await d.db.query(`SELECT
      (SELECT count(*)::int FROM crosses WHERE state IN ('Cleared', 'Finalized') AND clearing_price IS NOT NULL) AS crosses_printed,
      (SELECT count(*)::int FROM crosses) AS crosses_total,
      (SELECT count(DISTINCT owner)::int FROM orders WHERE side = 0 AND fill IS NOT NULL AND fill > 0) AS buyers_filled,
      (SELECT coalesce(sum(quote_out), 0)::text FROM orders WHERE side = 1 AND status = 'claimed') AS quote_to_sellers,
      (SELECT coalesce(sum(quote_out), 0)::text FROM orders WHERE side = 0 AND status = 'claimed') AS quote_refunded_to_buyers,
      (SELECT count(*)::int FROM crosses WHERE state = 'NoPrint' OR (state = 'Finalized' AND clearing_price IS NULL)) AS crosses_no_print`);
    return send(reply, { network: d.network ?? 'unknown', ...rows[0] });
  });

  // ---- measured metrics. Each is computed from the indexer's tables and the immutable fields of the
  // crosses (read from chain once, kept), cached for 15 s so a busy page does not recompute it, and
  // returned with its sample size and a method line. Nothing here is estimated or defaulted.
  const loadFacts = createFactsLoader(d.db, d.account);
  const memo = new Map<string, { at: number; value: Promise<unknown> }>();
  const cached = <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.value as Promise<T>;
    const value = compute();
    memo.set(key, { at: Date.now(), value });
    value.catch(() => memo.delete(key));
    return value;
  };
  const generatedAt = () => new Date().toISOString();
  if (d.warmMetrics) {
    loadFacts({ states: [...STATE] }).catch((e: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), metrics: 'warm-up failed; the first request will retry', error: String(e) })));
  }

  // GET /v1/metrics/execution
  //   What a bidder actually got, over every Finalized cross that printed: fill rate, price
  //   improvement of each filled bid against its own limit (median and 10th percentile, in basis
  //   points and quote atoms), the share of bid escrow returned, and close-to-finalized time.
  //   Every figure carries its sample size; `method` states how it was computed.
  //   200 { network, generatedAt, method, crosses, finalizedWithoutPrint, bids: { placed, filled, fillRate, ... },
  //         priceImprovement: { filledBids, atClearingPrice, bps: { median, p10 }, quoteAtoms: { median, p10, quoteDecimals }, inconsistent },
  //         refundShare: { crosses, median, min, max }, closeToFinalizedSeconds: { n, median, p90, max, excluded }, closeToClearedSeconds: {...} }
  app.get('/v1/metrics/execution', async (_req, reply) => {
    const out = await cached('execution', async () => executionQuality(await loadFacts({ states: ['Finalized'] })));
    return send(reply, { network: d.network ?? 'unknown', generatedAt: generatedAt(), ...out });
  });

  // GET /v1/metrics/fairness?threshold=0.1
  //   Concentration of fills over every Finalized cross that printed: for each cross and in
  //   aggregate, distinct wallets, the share of one side's fill taken by its largest 1, 5 and 10
  //   wallets, the identity count, and the proportion of crosses where the largest buyer took more
  //   than `threshold` (default 0.1) with a Wilson 95% interval over crosses.
  //   200 { network, generatedAt, method, crosses, threshold, topBuyerAboveThreshold: { k, n, proportion, wilsonLo, wilsonHi },
  //         medianBuySide, crossesWithSelfCross, wallets, perCross: [{ address, bidders, sellers, wallets, buy, sell, bothSides, identity }] }
  app.get('/v1/metrics/fairness', async (req, reply) => {
    const raw = (req.query as { threshold?: string }).threshold;
    const threshold = raw === undefined ? 0.1 : Number(raw);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new RequestError(400, 'threshold must be a number strictly between 0 and 1');
    const out = await cached(`fairness:${threshold}`, async () => fairnessReport(await loadFacts({ states: ['Finalized'] }), threshold));
    return send(reply, { network: d.network ?? 'unknown', generatedAt: generatedAt(), ...out });
  });

  // GET /v1/metrics/external-flow
  //   How much of the flow is not ours. Wallets and orders over every cross with orders, split into
  //   own (OWN_WALLETS, and each cross's creator, proceeds recipient, integrator and fee recipient)
  //   and external. When OWN_WALLETS is unset the external figures are an upper bound and the
  //   verdict says so.
  //   200 { network, generatedAt, method, ownWalletsConfigured, crosses: { withOrders, withAnExternalWallet, onlyOwnWallets },
  //         wallets: { total, own, external, externalShare }, filledWallets: {...}, orders: {...}, verdict }
  app.get('/v1/metrics/external-flow', async (_req, reply) => {
    const out = await cached('external-flow', async () => externalFlow(await loadFacts({ states: [...STATE] }), d.ownWallets ?? new Set(), d.network ?? 'unknown'));
    return send(reply, { generatedAt: generatedAt(), ...out });
  });

  app.get('/v1/crosses', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const state = q.state;
    if (state !== undefined && !STATE.includes(state as never)) throw new RequestError(400, `state must be one of ${STATE.join(', ')}`);
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    const { rows } = await d.db.query(
      `SELECT address, state, creator, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, clearing_price, matched, orders_committed, created_slot
       FROM crosses WHERE ($1::text IS NULL OR state = $1) ORDER BY created_slot DESC LIMIT $2`,
      [state ?? null, limit],
    );
    return send(reply, { crosses: rows });
  });

  app.get('/v1/crosses/:address', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const v = await crossView(a);
    // Additive: the cross's fairness figures once it has printed and finalized (null before, and null if the index cannot be read; the cross itself never fails on it).
    let fairness: ReturnType<typeof crossFairness> | null = null;
    if (v.data.state === CrossState.Finalized && v.data.clearing.__option === 'Some') {
      try {
        const facts = await loadFacts({ states: ['Finalized'], address: a });
        fairness = facts[0] ? crossFairness(facts[0]) : null;
      } catch (e) {
        console.error(JSON.stringify({ at: new Date().toISOString(), route: '/v1/crosses/:address', fairness: 'unavailable', error: String(e) }));
      }
    }
    // Additive: the base mint's current safety verdict (issuer powers, pause state). Null for a cross whose base mint is not
    // bound yet, and null if the mint cannot be read; the cross itself never fails on it.
    let mintSafety: Awaited<ReturnType<typeof safety.get>> | null = null;
    if (v.data.baseBound) {
      try {
        // The first read of a mint goes to a rate-limited public RPC and can take many seconds: wait a moment for it, then answer
        // without it (null). The read carries on in the cache, so the next request has the verdict.
        const read = safety.get(v.data.baseMint);
        read.catch(() => undefined);
        mintSafety = await Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), 1_500))]);
      } catch (e) {
        console.error(JSON.stringify({ at: new Date().toISOString(), route: '/v1/crosses/:address', safety: 'unavailable', error: String(e) }));
      }
    }
    return send(reply, { ...present(a, v.data), fairness, safety: mintSafety });
  });

  app.get('/v1/crosses/:address/orders', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const { rows } = await d.db.query(
      `SELECT idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee FROM orders WHERE cross_address = $1 ORDER BY idx`,
      [a],
    );
    return send(reply, { orders: rows.map((r) => ({ ...r, side: r.side === 0 ? 'buy' : 'sell' })) });
  });

  // The resting book (merged book plus unmerged shards) and the price it would clear at now.
  // Sealed crosses show nothing until bids are revealed: commitments carry no price.
  const bookCache = new Map<string, unknown>();
  app.get('/v1/crosses/:address/book', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const v = await crossView(a);
    const c = v.data;
    // A finalized cross never changes, so its book is read from chain once and served from memory afterwards.
    const frozen = c.state === CrossState.Finalized;
    const cachedBook = frozen ? bookCache.get(a) : undefined;
    if (cachedBook) return send(reply, cachedBook);
    const book = await loadBook(d.account, a, c);
    // A cross whose order-book account was never created has no orders; say so instead of failing the page that asks.
    if (typeof book === 'string') return send(reply, { disclosure: c.disclosure === Disclosure.Sealed ? 'sealed' : 'open', levels: [], indicative: null, note: `This cross has no order book on chain, so it holds no orders (${book}).` });
    const levels = [];
    for (let i = 0; i < c.ticks; i++) {
      if (book.buy[i] === 0n && book.sell[i] === 0n) continue;
      levels.push({ price: c.minPrice + BigInt(i) * c.tick, buy: book.buy[i]!, sell: book.sell[i]!, buyOrders: book.buyOrders[i]!, sellOrders: book.sellOrders[i]! });
    }
    const orders = levels.flatMap((l) => [
      ...(l.buy > 0n ? [{ side: 'buy' as const, price: l.price, quantity: l.buy }] : []),
      ...(l.sell > 0n ? [{ side: 'sell' as const, price: l.price, quantity: l.sell }] : []),
    ]);
    const r = c.state === CrossState.Live ? referenceClear(orders, { min: c.minPrice, tick: c.tick, ticks: c.ticks }, c.referencePrice.__option === 'Some' ? c.referencePrice.value : null) : null;
    const sealed = c.disclosure === Disclosure.Sealed;
    const payload = {
      disclosure: sealed ? 'sealed' : 'open',
      levels,
      indicative: r && { price: r.price, matched: r.matched },
      note:
        c.state !== CrossState.Live
          ? 'The book as it was cleared.'
          : sealed
            ? 'Sealed bids carry no price until they are revealed; only revealed orders appear here.'
            : 'Indicative until the call closes: later orders can move it.',
    };
    if (frozen) {
      if (bookCache.size >= 500) bookCache.delete(bookCache.keys().next().value as string);
      bookCache.set(a, payload);
    }
    return send(reply, payload);
  });

  // ---- signed, graded promises (ADR-0015)
  const cluster = d.network ?? 'unknown';
  const promiseView = async (id: string) => {
    const row = await getPromise(d.db, id);
    if (!row) return null;
    return { ...row.signed, grade: row.grade, anchor: await anchorFor(d.db, id) };
  };

  app.get('/v1/promises/signer', async (_req, reply) => send(reply, { schema: PROMISE_SCHEMA, cluster, signer: d.promiseSigner ?? null }));

  // ---- is this real? Identity of a mint against the issuers' own lists and the chain.
  // The registry describes mainnet mints, so on any other network there is no meaningful verdict.
  const authenticityBook = loadBundledBook();
  const authenticity = async (mint: Address) => {
    if (cluster !== 'mainnet-beta') return null;
    return classifyMint(authenticityBook, await observeVia(async (a) => d.account(a), mint));
  };
  const registryInfo = { network: 'mainnet-beta', snapshotHash: authenticityBook.data.snapshotHash, generatedAt: authenticityBook.data.generatedAt, sources: authenticityBook.data.sources.map((s) => ({ id: s.id, url: s.url, fetchedAt: s.fetchedAt, count: s.count })) };
  const NOT_COMPARABLE = `The authenticity registry lists mainnet mints; this API follows ${cluster}, where the same issuers have no listed mints, so no verdict is given.`;

  // GET /v1/tokens/:mint/safety
  //   What the issuer of this mint can do to escrowed balances, read from the mint account on chain (packages/token-safety):
  //   pause state, pause / permanent-delegate / freeze / mint / close authorities, transfer hook, transfer fee, default account
  //   state, non-transferable, display multiplier (and a scheduled change), interest, confidential transfers, unknown extensions.
  //   verdict: blocked (a cross cannot be created), halted (no cross can print while it holds), disclosures (issuer powers, cross
  //   proceeds), clear. Verdicts are cached 30 s and the read is retried when the RPC answers 429.
  //   200 { mint, tokenProgram, decimals, supply, uiMultiplier, verdict, crossable, summary, risks: [{ code, severity, level, message, holder? }], asOf, checkedAt, clock }
  //   404 the mint does not exist; 422 the account is not a token mint; 503 the RPC stayed busy
  app.get('/v1/tokens/:mint/safety', async (req, reply) => send(reply, await safety.get(address((req.params as { mint: string }).mint, 'mint'))));

  app.get('/v1/tokens/:mint/authenticity', async (req, reply) => {
    const mint = address((req.params as { mint: string }).mint, 'mint');
    const verdict = await authenticity(mint);
    return send(reply, verdict ? { comparable: true, verdict, registry: registryInfo } : { comparable: false, network: cluster, note: NOT_COMPARABLE, registry: registryInfo });
  });

  app.get('/v1/crosses/:address/authenticity', async (req, reply) => {
    const { data } = await crossView(address((req.params as { address: string }).address, 'address'));
    const base = data.baseBound ? await authenticity(data.baseMint) : null;
    const quote = await authenticity(data.quoteMint);
    if (cluster !== 'mainnet-beta') return send(reply, { comparable: false, network: cluster, note: NOT_COMPARABLE, registry: registryInfo });
    return send(reply, { comparable: true, base: base ? { mint: data.baseMint, verdict: base } : null, quote: { mint: data.quoteMint, verdict: quote }, registry: registryInfo });
  });

  app.get('/v1/crosses/:address/promise', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const last = await latestForCross(d.db, a);
    const none = 'no promise has been issued for this cross (sealed crosses and books that do not cross yet have none)';
    // A page asks with ?optional=1 so that "no band yet" is an ordinary answer, not a failed request in the browser console.
    if (!last && (req.query as { optional?: string }).optional === '1') return send(reply, { promise: null, note: none });
    if (!last) throw new RequestError(404, none);
    return send(reply, await promiseView(last.signed.promise.id));
  });

  app.get('/v1/promises/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RequestError(400, 'id must be 64 lowercase hex characters');
    const v = await promiseView(id);
    if (!v) throw new RequestError(404, `promise ${id} not found`);
    return send(reply, v);
  });

  app.get('/v1/promises/:id/inputs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RequestError(400, 'id must be 64 lowercase hex characters');
    const inputs = await getInputs(d.db, id);
    if (!inputs) throw new RequestError(404, `promise ${id} not found`);
    return send(reply, inputs);
  });

  app.get('/v1/accuracy', async (_req, reply) => {
    const { rows } = await records(d.db, cluster);
    return send(reply, { cluster, signer: d.promiseSigner ?? null, ...accuracyReport(rows, await samples(d.db, cluster)) });
  });

  // ---- premium monitor (ADR-0017). It measures mainnet liquidity whichever cluster this API follows.
  const PREMIUM_CLUSTER = 'mainnet-beta';
  app.get('/v1/premium/summary', async (req, reply) => {
    const days = Number((req.query as { days?: string }).days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new RequestError(400, 'days must be a whole number from 1 to 90');
    const since = Math.floor(Date.now() / 1000) - days * 86_400;
    const [obs, cov] = await Promise.all([observationsSince(d.db, PREMIUM_CLUSTER, since), premiumCoverage(d.db, PREMIUM_CLUSTER, since)]);
    return send(reply, {
      cluster: PREMIUM_CLUSTER,
      unit: 'basis points x 100, signed; positive is above the reference',
      reference: 'hip3_oracle',
      days,
      coverage: cov,
      groups: groupObservations(obs),
    });
  });

  app.get('/v1/premium/latest', async (_req, reply) => {
    const obs = await latestPerTicker(d.db, PREMIUM_CLUSTER);
    return send(reply, { cluster: PREMIUM_CLUSTER, unit: 'basis points x 100, signed', observations: obs });
  });

  app.get('/v1/crosses/:address/proof', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    await crossView(a);
    return send(reply, await verifyCross(fetchOwned, a));
  });

  // Batch order lookup: open orders read from chain, closed ones from the index. Unknown addresses
  // (e.g. placed seconds ago and not yet finalized, or never placed) come back as found: false.
  app.get('/v1/orders', async (req, reply) => {
    const raw = (req.query as { addresses?: string }).addresses;
    if (!raw) throw new RequestError(400, 'addresses must be a comma-separated list of order addresses');
    const list = raw.split(',').filter(Boolean);
    if (list.length > 100) throw new RequestError(400, 'at most 100 addresses per request');
    const out = [];
    for (const item of list) {
      const a = address(item, 'addresses');
      const data = owned(await d.account(a), ORDER_DISCRIMINATOR as Uint8Array);
      if (data) {
        const o = getOrderDecoder().decode(data);
        out.push({ address: a, found: true, open: true, cross: o.cross, owner: o.owner, nonce: o.nonce, index: o.index, side: o.side === 0 ? 'buy' : 'sell', revealed: o.state === 1, escrow: o.escrow });
        continue;
      }
      const { rows } = await d.db.query('SELECT * FROM orders WHERE address = $1', [a]);
      out.push(rows[0] ? { ...rows[0], found: true, side: rows[0].side === 0 ? 'buy' : 'sell', open: false } : { address: a, found: false });
    }
    return send(reply, { orders: out });
  });

  app.get('/v1/orders/:address', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const acct = await d.account(a);
    const data = owned(acct, ORDER_DISCRIMINATOR as Uint8Array);
    if (!data) {
      const { rows } = await d.db.query('SELECT * FROM orders WHERE address = $1', [a]);
      if (!rows[0]) throw new RequestError(404, `order ${a} not found`);
      return send(reply, { ...rows[0], side: rows[0].side === 0 ? 'buy' : 'sell', open: false });
    }
    const o = getOrderDecoder().decode(data);
    return send(reply, { address: a, cross: o.cross, owner: o.owner, nonce: o.nonce, index: o.index, side: o.side === 0 ? 'buy' : 'sell', revealed: o.state === 1, escrow: o.escrow, open: true });
  });

  app.get('/v1/owners/:owner/orders', async (req, reply) => {
    const owner = address((req.params as { owner: string }).owner, 'owner');
    const { rows } = await d.db.query(`SELECT cross_address, idx, address, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee FROM orders WHERE owner = $1 ORDER BY created_slot DESC LIMIT 500`, [owner]);
    return send(reply, { orders: rows.map((r) => ({ ...r, side: r.side === 0 ? 'buy' : 'sell' })) });
  });

  // GET /v1/router/quote?base=<mint>&quote=<mint>&side=buy|sell&amount=<base atoms>
  //   Where would this order get the best price right now? Compares the venues the router package really prices:
  //     * every live cross of the pair (open books: the clearing rule re-run on the live book with this order added, net of
  //       the cross's fees; sealed books: no indicative price, so excluded with that reason);
  //     * Jupiter, a live route for the same size (mainnet only: on any other network it is excluded with that reason).
  //   Meteora pools are NOT priced by the router; they are listed under `excluded` with that statement (Jupiter's route names
  //   any Meteora pool it uses). Nothing is signed or sent. Prices are quote atoms per one whole base token, so venues compare.
  //   Ranked: venues filling the whole amount first, then by better price for the side; partial fills after, by size.
  //   200 { schema, network, at, intent, base: { decimals }, priceUnit, venues: [{ rank, venue, quoteAtoms, baseAtoms, pricePerBase, fill, ... }],
  //         excluded: [{ venue, cross?, reason }], best, caveats }
  //   400 bad query; 404 base or quote mint absent on chain; 422 not a token mint; 503 RPC busy
  app.get('/v1/router/quote', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const baseMint = address(q.base, 'base');
    const quoteMint = address(q.quote, 'quote');
    if (baseMint === quoteMint) throw new RequestError(400, 'base and quote must be different mints');
    const sideName = q.side;
    if (sideName !== 'buy' && sideName !== 'sell') throw new RequestError(400, 'side must be "buy" or "sell"');
    const amount = u64(q.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be at least 1 base atom');
    const intent: Intent = { side: sideName, quantity: amount };
    const baseDecimals = (await safety.get(baseMint)).decimals;
    await safety.get(quoteMint);
    const nowSeconds = d.clock ? d.clock() : Math.floor(Date.now() / 1000);
    const { rows } = await d.db.query(
      `SELECT address FROM crosses WHERE state = 'Live' AND base_mint = $1 AND quote_mint = $2 AND close_ts > $3 ORDER BY close_ts LIMIT 5`,
      [baseMint, quoteMint, nowSeconds],
    );
    const crosses = [];
    for (const r of rows) crosses.push(await quoteCross(d.account, r.address as Address, intent, BigInt(nowSeconds)));
    const jupiter = d.dexQuote ?? ((p: { baseMint: Address; quoteMint: Address; intent: Intent }) => quoteJupiter({ ...p, fetchImpl: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(8000) }) }));
    const dex =
      cluster !== 'mainnet-beta' && !d.dexQuote
        ? { skipped: `Jupiter routes mainnet liquidity only; this API follows ${cluster}, so no DEX route exists for these mints.` }
        : await jupiter({ baseMint, quoteMint, intent }).catch((e: unknown): DexQuote => ({ venue: 'jupiter', available: false, reason: `Jupiter could not be reached: ${String(e)}` }));
    const ranking = rankVenues({ side: sideName, amount, baseDecimals, crosses, dex });
    return send(reply, {
      schema: 'opening-cross/router-quote/v1',
      network: cluster,
      at: new Date(nowSeconds * 1000).toISOString(),
      intent: { base: baseMint, quote: quoteMint, side: sideName, amount },
      base: { decimals: baseDecimals },
      priceUnit: 'quote atoms per one whole base token',
      ...ranking,
    });
  });

  // POST /v1/route/quote  { cross, side: "buy"|"sell", quantity: <base atoms>, limitPrice?: <cross price units> }
  //   Best execution for one order on one cross (what @opening-cross/client `routeQuote`, the CLI `quote` command and the React
  //   `useBestExecution` hook call): the router package's `opening-cross/best-execution/v1` report comparing joining this cross with
  //   a live Jupiter route for the same size, prices in the cross's units, the difference in basis points, a recommendation and
  //   every caveat. Jupiter prices mainnet liquidity only: on another network the report says the DEX route is unavailable.
  //   200 the report   400 bad body   404 no such cross   409 the cross is not accepting orders
  app.post('/v1/route/quote', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is not accepting orders');
    const quantity = u64(b.quantity, 'quantity');
    if (quantity === 0n) throw new RequestError(400, 'quantity must be at least 1 base atom');
    const limitPrice = opt(b.limitPrice, (x) => u64(x, 'limitPrice'));
    const intent: Intent = { side: side(b.side) === OrderSide.Buy ? 'buy' : 'sell', quantity, ...(limitPrice !== null && { limitPrice }) };
    const nowSeconds = d.clock ? d.clock() : Math.floor(Date.now() / 1000);
    const crossQuote = await quoteCross(d.account, cross.address, intent, BigInt(nowSeconds));
    const dexQuote: DexQuote =
      cluster !== 'mainnet-beta' && !d.dexQuote
        ? { venue: 'jupiter', available: false, reason: `Jupiter routes mainnet liquidity only; this API follows ${cluster}` }
        : await (d.dexQuote ?? ((p) => quoteJupiter({ ...p, fetchImpl: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(8000) }) })))({ baseMint: cross.data.baseMint, quoteMint: cross.data.quoteMint, intent }).catch((e: unknown): DexQuote => ({ venue: 'jupiter', available: false, reason: `Jupiter could not be reached: ${String(e)}` }));
    return send(reply, bestExecution(intent, crossQuote, dexQuote, cross.data.priceScale, new Date(nowSeconds * 1000)));
  });

  // GET /v1/replay/:address
  //   Launch replay: every on-chain event of one cross in order (created, orders placed, reveals, cancels, cleared, claims,
  //   finalized) with slot, block time and transaction signature, from the indexed event log. An open order's limit price and
  //   quantity are included; a sealed order shows no price until its reveal event. `complete` is true once the cross is finalized.
  //   200 { cross, complete, state, summary, events: [{ n, kind, event, slot, time, signature, details }] }   404 not indexed
  app.get('/v1/replay/:address', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const r = await replayRow(d.db, a);
    if (!r) throw new RequestError(404, `cross ${a} is not in the index`);
    const kinds = new Set(r.events.map((e) => e.kind));
    return send(reply, {
      cross: a,
      complete: r.cross.state === 'Finalized',
      state: r.cross.state,
      source: 'indexer event log (cross_core logs)',
      summary: {
        events: r.events.length,
        ordersPlaced: r.events.filter((e) => e.kind === 'order_placed').length,
        revealed: r.events.filter((e) => e.kind === 'order_revealed').length,
        cancelled: r.events.filter((e) => e.kind === 'order_cancelled').length,
        claimed: r.events.filter((e) => e.kind === 'order_claimed').length,
        cleared: kinds.has('cleared'),
        finalized: kinds.has('finalized'),
        clearingPrice: r.cross.clearing_price,
        matched: r.cross.matched,
        firstEventAt: r.events[0]?.time ?? null,
        lastEventAt: r.events.at(-1)?.time ?? null,
      },
      events: r.events,
    });
  });

  // GET /v1/replay?days=30&limit=50
  //   Crosses whose call opened in the last `days` days (1-365, default 30), newest first, each with its outcome, order and
  //   wallet counts and the times of its first order, clearing and finalization, from the index.
  //   200 { network, days, count, crosses: [...] }
  app.get('/v1/replay', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.days === undefined ? 30 : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new RequestError(400, 'days must be a whole number from 1 to 365');
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    const crosses = await recentReplays(d.db, days, limit, d.clock ? d.clock() : Math.floor(Date.now() / 1000));
    return send(reply, { network: cluster, days, count: crosses.length, crosses });
  });

  // ---------------------------------------------------------------- unsigned transactions
  app.post('/v1/tx/place-order', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is not accepting orders');
    const salt = opt(b.salt, (x) => hex32(x, 'salt'));
    const escrow = opt(b.escrow, (x) => u64(x, 'escrow'));
    const out = await placeOrderTx(fetchOwned, cross, { owner: address(b.owner, 'owner'), nonce: u64(b.nonce, 'nonce'), side: side(b.side), price: u64(b.price, 'price'), quantity: u64(b.quantity, 'quantity'), ...(escrow !== null && { escrow }), ...(salt && { salt }) }, await d.lifetime());
    return send(reply, out);
  });

  app.post('/v1/tx/cancel', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    return send(reply, await cancelTx(fetchOwned, cross, { owner: address(b.owner, 'owner'), nonce: u64(b.nonce, 'nonce') }, await d.lifetime()));
  });

  app.post('/v1/tx/reveal', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    return send(reply, await revealTx(fetchOwned, cross, { owner: address(b.owner, 'owner'), nonce: u64(b.nonce, 'nonce'), price: u64(b.price, 'price'), quantity: u64(b.quantity, 'quantity'), salt: hex32(b.salt, 'salt') }, await d.lifetime()));
  });

  app.post('/v1/tx/settle', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is already settled');
    const oracle = opt(b.oraclePrice, (x) => address(x, 'oraclePrice'));
    return send(reply, { transactions: await settleTxs(cross, address(b.payer, 'payer'), await d.lifetime(), oracle ?? undefined) });
  });

  app.post('/v1/tx/claim', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    if (cross.data.state === CrossState.Live) throw new RequestError(409, 'cross has not settled yet');
    if (cross.data.state === CrossState.Finalized) throw new RequestError(409, 'cross is finalized: every order has already been paid or refunded');
    const owner = address(b.owner, 'owner');
    return send(reply, await claimTx(fetchOwned, cross, { payer: opt(b.payer, (x) => address(x, 'payer')) ?? owner, owner, nonce: u64(b.nonce, 'nonce') }, await d.lifetime()));
  });

  app.post('/v1/tx/finalize', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    if (cross.data.ordersOpen !== 0) throw new RequestError(409, `${cross.data.ordersOpen} orders are still open`);
    return send(reply, await finalizeTx(cross, address(b.payer, 'payer'), await d.lifetime()));
  });

  // Finishes a cross whose create transaction landed but whose shard transactions did not (see buildMissingShards).
  app.post('/v1/tx/init-shards', async (req, reply) => {
    const b = body(req.body);
    const cross = await crossView(address(b.cross, 'cross'));
    return send(reply, await initShardsTxs(fetchOwned, cross, address(b.payer, 'payer'), await d.lifetime()));
  });

  app.post('/v1/tx/create-cross', async (req, reply) => {
    const b = body(req.body);
    const enumOf = (v: unknown, field: string, names: string[]) => {
      const i = names.indexOf(String(v));
      if (i < 0) throw new RequestError(400, `${field} must be one of ${names.join(', ')}`);
      return i;
    };
    const schedule = b.schedule === undefined ? [] : Array.isArray(b.schedule) ? b.schedule.map((s, i) => ({ price: u64((s as Record<string, unknown>)?.price, `schedule[${i}].price`), quantity: u64((s as Record<string, unknown>)?.quantity, `schedule[${i}].quantity`) })) : (() => { throw new RequestError(400, 'schedule must be an array'); })();
    const oracle = opt(b.oracle, (o) => {
      const r = body(o);
      return { feedId: hex32(r.feedId, 'oracle.feedId'), maxDivergenceBps: int(r.maxDivergenceBps, 'oracle.maxDivergenceBps', 10_000), maxStalenessSecs: int(r.maxStalenessSecs, 'oracle.maxStalenessSecs', 86_400) };
    });
    const baseMint = opt(b.baseMint, (x) => address(x, 'baseMint'));
    const params = (
      {
        creator: address(b.creator, 'creator'),
        ...(baseMint && { baseMint }),
        quoteMint: address(b.quoteMint, 'quoteMint'),
        baseTokenProgram: address(b.baseTokenProgram, 'baseTokenProgram'),
        quoteTokenProgram: address(b.quoteTokenProgram, 'quoteTokenProgram'),
        crossId: u64(b.crossId, 'crossId'),
        kind: enumOf(b.kind, 'kind', ['launch', 'reopen', 'tender', 'recurring']),
        supplyMode: enumOf(b.supplyMode, 'supplyMode', ['escrow', 'mint', 'deferred-mint']),
        disclosure: enumOf(b.disclosure, 'disclosure', ['sealed', 'open']),
        minPrice: u64(b.minPrice, 'minPrice'),
        tick: u64(b.tick, 'tick'),
        ticks: int(b.ticks, 'ticks', 65_535),
        priceScale: u64(b.priceScale, 'priceScale'),
        openTs: u64(b.openTs, 'openTs'),
        closeTs: u64(b.closeTs, 'closeTs'),
        revealEndTs: u64(b.revealEndTs, 'revealEndTs'),
        referencePrice: opt(b.referencePrice, (x) => u64(x, 'referencePrice')),
        minMatched: u64(b.minMatched ?? '0', 'minMatched'),
        maxImbalanceBps: opt(b.maxImbalanceBps, (x) => int(x, 'maxImbalanceBps', 10_000)),
        integratorFeeBps: int(b.integratorFeeBps ?? 0, 'integratorFeeBps', 300),
        integrator: address(b.integrator, 'integrator'),
        gateMint: opt(b.gateMint, (x) => address(x, 'gateMint')),
        shards: int(b.shards, 'shards', 32),
        maxOrders: int(b.maxOrders, 'maxOrders', 1_000_000),
        proceedsTo: address(b.proceedsTo, 'proceedsTo'),
        schedule,
        oracle,
        calendar: opt(b.calendar, (x) => address(x, 'calendar')),
        settler: opt(b.settler, (x) => address(x, 'settler')),
        settleDeadlineTs: u64(b.settleDeadlineTs ?? '0', 'settleDeadlineTs'),
      } as Parameters<typeof createCrossTxs>[0]
    );
    // Issuer-power gate (packages/token-safety policy). Every field above is already validated, so this only reads chain.
    // A mint with a blocking property (active transfer hook, transfer fee, non-transferable, unknown extension) is refused with a
    // typed reason before any transaction is built; halts and disclosures come back as warnings with the transactions.
    const warnings: Awaited<ReturnType<typeof safety.get>>['risks'] = [];
    for (const [role, mint] of [['base', params.baseMint], ['quote', params.quoteMint]] as const) {
      if (!mint) continue; // a deferred-mint cross has no base mint yet
      let v;
      try {
        v = await safety.get(mint);
      } catch (e) {
        if (e instanceof RequestError && (e.status === 404 || e.status === 422)) {
          throw new RequestError(422, `${role} mint ${mint}: ${e.message}`, { reason: e.status === 404 ? 'MINT_NOT_FOUND' : 'NOT_A_TOKEN_MINT', role, mint });
        }
        throw e;
      }
      const { blockers, warnings: soft } = gate(v);
      if (blockers.length > 0) {
        throw new RequestError(422, `${role} mint ${mint} cannot be used in a cross: ${blockers.map((r) => r.message).join(' ')}`, { reason: 'MINT_NOT_CROSSABLE', code: blockers[0]!.code, role, mint, blockers });
      }
      warnings.push(...soft.map((r) => ({ ...r, message: `${role} mint: ${r.message}` })));
    }
    const out = await createCrossTxs(params, await d.lifetime());
    return send(reply, { ...out, warnings });
  });

  // ---------------------------------------------------------------- stream
  // One LISTEN connection fans out to every socket; a socket may filter to one cross.
  const sockets = new Set<{ cross: string | null; send: (s: string) => void }>();
  if (d.listen) {
    const client = await d.listen();
    await client.query('LISTEN opening_cross_events');
    // Notifications arrive in commit order; handle them one at a time so the row reads (async)
    // cannot reorder them on the way to subscribers.
    let chain = Promise.resolve();
    client.on('notification', (n) => {
      chain = chain.then(async () => {
        const key = JSON.parse(n.payload ?? '{}') as { signature: string; seq: number };
        const { rows } = await d.db.query('SELECT signature, seq, slot, name, cross_address AS cross, payload FROM events WHERE signature = $1 AND seq = $2', [key.signature, key.seq]);
        const ev = rows[0];
        if (!ev) return;
        const msg = json({ type: 'event', ...ev });
        for (const s of sockets) if (s.cross === null || s.cross === ev.cross) s.send(msg);
      }).catch((e: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), stream: 'event delivery failed', error: String(e) })));
    });
    app.addHook('onClose', async () => {
      await client.end();
    });
  }
  app.get('/v1/stream', { websocket: true }, (socket, req) => {
    const q = req.query as { cross?: string };
    if (q.cross !== undefined && !isAddress(q.cross)) {
      socket.send(json({ type: 'error', error: 'cross must be a base58 Solana address' }));
      socket.close(1008);
      return;
    }
    const sub = { cross: q.cross ?? null, send: (s: string) => socket.send(s) };
    sockets.add(sub);
    socket.send(json({ type: 'subscribed', cross: sub.cross }));
    socket.on('close', () => sockets.delete(sub));
  });

  return app;
}
