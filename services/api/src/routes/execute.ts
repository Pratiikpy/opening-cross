// Router execution and signed intents (PRODUCT_FEATURES Z1 open-execution router, W9 aggregator intents).
//
// `GET /v1/router/quote` ranks the venues for an order and stops there. These routes take the next step: they build the
// UNSIGNED transaction for the winning venue. Nothing is signed or sent here and the API holds no key; the owner's wallet signs.
//
//   POST /v1/route/execute            { base, quote, side, amount, owner, limitPrice?, slackTicks?, cross?, salt? }
//        Ranks the live crosses of the pair against a Jupiter route and returns the transaction for the best venue:
//        a place-order transaction for a cross, or a Jupiter swap transaction. Jupiter routes MAINNET liquidity only, so on
//        devnet the only venue that can win is a cross, and the answer says why there is no DEX route.
//   POST /v1/intents                  a signed intent (packages/liquidity): stored, attributable, replay-proof
//   GET  /v1/intents?owner=           the unexpired intents of a wallet
//   POST /v1/intents/:id/execute      matches the intent to the pair's live crosses now and answers like /v1/route/execute
//
// An intent does not delegate anything. cross_core has no way to let a third party place an order for a wallet, so executing an
// intent produces a transaction the owner still has to sign; what the intent gives a router is a signed, expiring instruction
// to act on when a suitable cross is open.
//
// A cross price is indicative until the call closes, so the limit is a bound, not a promise of the price: a buy limit is the
// indicative clearing price plus `slackTicks` grid steps (default 2), a sell limit minus the same, unless the caller names one.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, OrderSide, getCrossDecoder } from '@opening-cross/sdk';
import { type DexQuote, type Intent as RouterIntent, jupiterSwapTransaction, quoteCross, quoteJupiter } from '@opening-cross/router';
import { type CrossFacts, type SignedIntent, matchCrosses, verifyIntent } from '@opening-cross/liquidity';
import { randomNonce } from '@opening-cross/client';
import type { ApiDeps } from '../server.js';
import { type Lifetime, RequestError, placeOrderTx } from '../tx.js';
import { type Ranking, rankVenues } from '../venues.js';
import { jsonRpcSimulate } from './simulate.js';

export type ExecuteDeps = Pick<ApiDeps, 'db' | 'account' | 'lifetime' | 'clock' | 'network' | 'dexQuote'>;
export type ExecuteOptions = {
  /** Jupiter's base URL; default is the public lite API the router package uses. */
  jupiterBase?: string;
  fetchImpl?: typeof fetch;
  /** Simulates an unsigned transaction on the cluster; default JSON-RPC at `RPC_URL`. Without one configured, no simulation is returned. */
  simulate?: (wireBase64: string) => Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null }>;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAX_SLACK_TICKS = 50;

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
function u64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s) || BigInt(s) >= 1n << 64n) throw new RequestError(400, `${field} must be an unsigned 64-bit integer (decimal string)`);
  return BigInt(s);
}

type Request = { base: Address; quote: Address; side: 'buy' | 'sell'; amount: bigint; owner: Address; limitPrice: bigint | null; slackTicks: number; cross: Address | null; salt: Uint8Array | null };

function parseRequest(b: unknown): Request {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RequestError(400, 'request body must be a JSON object');
  const r = b as Record<string, unknown>;
  const base = addr(r.base, 'base');
  const quote = addr(r.quote, 'quote');
  if (base === quote) throw new RequestError(400, 'base and quote must be different mints');
  if (r.side !== 'buy' && r.side !== 'sell') throw new RequestError(400, 'side must be "buy" or "sell"');
  const amount = u64(r.amount, 'amount');
  if (amount === 0n) throw new RequestError(400, 'amount must be at least 1 base atom');
  const slack = r.slackTicks === undefined ? 2 : r.slackTicks;
  if (typeof slack !== 'number' || !Number.isInteger(slack) || slack < 0 || slack > MAX_SLACK_TICKS) throw new RequestError(400, `slackTicks must be an integer from 0 to ${MAX_SLACK_TICKS}`);
  const salt = r.salt === undefined ? null : typeof r.salt === 'string' && /^[0-9a-fA-F]{64}$/.test(r.salt) ? Uint8Array.from(Buffer.from(r.salt, 'hex')) : (() => { throw new RequestError(400, 'salt must be 32 bytes of hex'); })();
  return {
    base, quote, side: r.side, amount, owner: addr(r.owner, 'owner'),
    limitPrice: r.limitPrice === undefined || r.limitPrice === null ? null : u64(r.limitPrice, 'limitPrice'),
    slackTicks: slack, cross: r.cross === undefined || r.cross === null ? null : addr(r.cross, 'cross'), salt,
  };
}

export function registerExecute(app: FastifyInstance, d: ExecuteDeps, opts: ExecuteOptions = {}): void {
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const cluster = d.network ?? 'unknown';
  const simulate = opts.simulate ?? (process.env.RPC_URL ? (w: string) => jsonRpcSimulate(process.env.RPC_URL!, w) : null);
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(8_000) }));

  async function decimalsOf(mint: Address): Promise<number> {
    const acct = await d.account(mint);
    if (!acct) throw new RequestError(404, `mint ${mint} was not found on chain`);
    if ((acct.owner as string) !== TOKEN && (acct.owner as string) !== TOKEN_2022) throw new RequestError(422, `${mint} is not a token mint`);
    return acct.data[44]!;
  }

  async function loadCross(a: Address) {
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !CROSS_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return { address: a, data: getCrossDecoder().decode(acct.data) };
  }

  async function execute(req: Request) {
    const nowS = now();
    const intent: RouterIntent = { side: req.side, quantity: req.amount };
    const baseDecimals = await decimalsOf(req.base);
    await decimalsOf(req.quote);

    // The venues. A cross named by the caller is the only candidate (that is how a sealed cross, which has no indicative price, is bid in).
    const rows = req.cross
      ? [{ address: req.cross }]
      : (await d.db.query<{ address: string }>(`SELECT address FROM crosses WHERE state = 'Live' AND base_mint = $1 AND quote_mint = $2 AND close_ts > $3 ORDER BY close_ts LIMIT 5`, [req.base, req.quote, nowS])).rows;
    const crosses = [];
    for (const r of rows) crosses.push(await quoteCross(d.account, r.address as Address, intent, BigInt(nowS)));
    const jupiter = d.dexQuote ?? ((p: { baseMint: Address; quoteMint: Address; intent: RouterIntent }) => quoteJupiter({ ...p, fetchImpl }));
    const dex: DexQuote | { skipped: string } =
      cluster !== 'mainnet-beta' && !d.dexQuote
        ? { skipped: `Jupiter routes mainnet liquidity only; this API follows ${cluster}, so there is no DEX route for these mints.` }
        : await jupiter({ baseMint: req.base, quoteMint: req.quote, intent }).catch((e: unknown): DexQuote => ({ venue: 'jupiter', available: false, reason: `Jupiter could not be reached: ${String(e)}` }));
    let ranking: Ranking = rankVenues({ side: req.side, amount: req.amount, baseDecimals, crosses, dex });

    // A named cross is built even when it has no indicative price (sealed) as long as the caller gave a limit.
    let winner = ranking.best;
    if (req.cross && !winner) {
      if (req.limitPrice === null) throw new RequestError(422, 'this cross has no indicative price (it is sealed, empty or would not print); name a limitPrice to bid anyway', { ranking });
      winner = { venue: 'cross', cross: req.cross };
    }
    if (!winner) throw new RequestError(422, 'no venue can fill this order right now', { excluded: ranking.excluded, caveats: ranking.caveats });
    ranking = { ...ranking, caveats: [...ranking.caveats.filter((c) => c !== 'This is a quote comparison only. Nothing is signed or sent.'), 'The transaction below is unsigned. Nothing is sent until the owner signs it.'] };

    if (winner.venue === 'jupiter') {
      const swap = await jupiterSwapTransaction({ baseMint: req.base, quoteMint: req.quote, intent, userPublicKey: req.owner, fetchImpl, ...(opts.jupiterBase ? { baseUrl: opts.jupiterBase } : {}) });
      return { schema: 'opening-cross/route-execution/v1', network: cluster, venue: 'jupiter' as const, transaction: swap.transaction, signers: [req.owner], lastValidBlockHeight: swap.lastValidBlockHeight, order: null, limit: null, escrow: null, jupiter: { ...swap.quote }, message: `Swap through ${swap.quote.route.join(', ')}. Jupiter executes now within ${swap.quote.slippageBps / 100}% slippage.`, ranking };
    }

    const view = await loadCross(winner.cross!);
    const c = view.data;
    if (c.state !== CrossState.Live || BigInt(nowS) >= c.closeTs) throw new RequestError(409, 'the cross has closed; it takes no new orders');
    if (BigInt(nowS) < c.openTs) throw new RequestError(409, 'the cross has not opened yet');
    if (c.gateMint.__option === 'Some') throw new RequestError(409, 'this cross is for holders of a pass; claim one first (GET /v1/gates)');
    const sealed = c.disclosure === Disclosure.Sealed;
    if (sealed && !req.salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
    const top = c.minPrice + BigInt(c.ticks - 1) * c.tick;
    const named = crosses.find((q) => q.cross === view.address);
    const indicative = named && named.available && named.indicative?.prints ? named.indicative : null;
    let limit: bigint;
    let limitSource: string;
    if (req.limitPrice !== null) {
      if (req.limitPrice < c.minPrice || req.limitPrice > top || (req.limitPrice - c.minPrice) % c.tick !== 0n) throw new RequestError(400, `limitPrice ${req.limitPrice} is not on the grid (minimum ${c.minPrice}, step ${c.tick}, ${c.ticks} steps)`);
      limit = req.limitPrice;
      limitSource = 'the limit you named';
    } else {
      const p = indicative?.price;
      if (p === null || p === undefined) throw new RequestError(422, 'no indicative price to set a limit from; name a limitPrice');
      const slack = BigInt(req.slackTicks) * c.tick;
      limit = req.side === 'buy' ? (p + slack > top ? top : p + slack) : p - slack < c.minPrice ? c.minPrice : p - slack;
      limitSource = `the indicative clearing price ${p} ${req.side === 'buy' ? 'plus' : 'minus'} ${req.slackTicks} grid step${req.slackTicks === 1 ? '' : 's'}`;
    }
    const lt: Lifetime = await d.lifetime();
    const tx = await placeOrderTx(async (a) => (await d.account(a))?.data ?? null, view, { owner: req.owner, nonce: BigInt(randomNonce()), side: req.side === 'buy' ? OrderSide.Buy : OrderSide.Sell, price: limit, quantity: req.amount, ...(req.salt ? { salt: req.salt } : {}) }, lt);
    const escrow = req.side === 'buy' ? (req.amount * limit + c.priceScale - 1n) / c.priceScale : req.amount;
    const preflight = simulate ? await simulate(tx.transaction).catch((e: unknown) => ({ unavailable: String(e).slice(0, 200) })) : null;
    return {
      schema: 'opening-cross/route-execution/v1', network: cluster, venue: 'cross' as const, cross: view.address,
      transaction: tx.transaction, signers: tx.signers, lastValidBlockHeight: lt.lastValidBlockHeight, order: tx.order,
      limit: { price: limit, source: limitSource, note: 'Everyone filled in the cross pays the same clearing price; the limit only bounds it.' },
      escrow: { atoms: escrow, asset: req.side === 'buy' ? 'quote' : 'base' },
      sealed, ...(sealed ? { reveal: 'Keep the salt: the order must be revealed after the call closes or it is refunded unfilled.' } : {}),
      preflight, message: `Join the cross ${view.address}: ${req.side} up to ${req.amount} base atoms with a limit of ${limit}.`, ranking,
    };
  }

  app.post('/v1/route/execute', async (req, reply) => send(reply, await execute(parseRequest(req.body))));

  // ---------------------------------------------------------------- intents
  app.post('/v1/intents', async (req, reply) => {
    const doc = req.body as SignedIntent | null;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.body !== 'object') throw new RequestError(400, 'request body must be a signed intent');
    const v = await verifyIntent(doc, now());
    if (!v.ok) throw new RequestError(400, `the intent is not valid: ${v.reason}`, { reason: v.reason });
    const b = doc.body;
    await d.db.query(`INSERT INTO intents (id, owner, base_mint, quote_mint, expires_at, intent) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [doc.id, b.owner, b.baseMint, b.quoteMint, b.expiresAt, JSON.stringify(doc)]);
    return send(reply, { id: doc.id, note: 'Stored. An intent gives no one the right to move your funds: executing it returns a transaction that you still sign.' }, 201);
  });

  app.get('/v1/intents', async (req, reply) => {
    const owner = (req.query as { owner?: string }).owner;
    const who = addr(owner, 'owner');
    const { rows } = await d.db.query<{ intent: SignedIntent }>('SELECT intent FROM intents WHERE owner = $1 AND expires_at > $2 ORDER BY expires_at LIMIT 100', [who, now()]);
    return send(reply, { intents: rows.map((r) => r.intent) });
  });

  // A client that executes an intent has nothing to send, but many HTTP clients still declare a JSON body. Fastify's default parser
  // answers an empty JSON body with an error; inside this scope (and only here) an empty body is simply no body.
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, text, done) => {
      if (text === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text as string));
      } catch {
        done(Object.assign(new Error('the request body is not valid JSON'), { statusCode: 400 }), undefined);
      }
    });
    scope.post('/v1/intents/:id/execute', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/^[0-9a-f]{64}$/.test(id)) throw new RequestError(400, 'id must be 64 lowercase hex characters');
      const row = (await d.db.query<{ intent: SignedIntent }>('SELECT intent FROM intents WHERE id = $1', [id])).rows[0];
      if (!row) throw new RequestError(404, `intent ${id} not found`);
      const t = now();
      const v = await verifyIntent(row.intent, t);
      if (!v.ok) throw new RequestError(409, `this intent can no longer be executed: ${v.reason}`, { reason: v.reason });
      const b = row.intent.body;
      // Which crosses could take it right now, and why each other one cannot: an empty answer is explained.
      const candidates = (await d.db.query<{ address: string; state: string; base_mint: string; quote_mint: string; open_ts: string; close_ts: string; disclosure: number }>(
        `SELECT address, state, base_mint, quote_mint, open_ts::text, close_ts::text, disclosure FROM crosses WHERE base_mint = $1 AND quote_mint = $2 ORDER BY close_ts DESC LIMIT 20`, [b.baseMint, b.quoteMint],
      )).rows;
      const facts: CrossFacts[] = candidates.map((c) => ({ address: c.address, state: c.state, baseMint: c.base_mint, quoteMint: c.quote_mint, openTs: BigInt(c.open_ts), closeTs: BigInt(c.close_ts), sealed: c.disclosure === 0 }));
      const matches = matchCrosses(b, facts, BigInt(t));
      const eligible = matches.filter((m) => m.reason === null && !m.cross.sealed);
      if (eligible.length === 0) {
        throw new RequestError(409, 'no open cross of this pair can take the intent right now', { checked: matches.map((m) => ({ cross: m.cross.address, reason: m.reason ?? (m.cross.sealed ? 'is sealed: a sealed bid needs a salt only the signer keeps; send it to /v1/route/execute with a cross and a salt' : null) })) });
      }
      const out = await execute({ base: b.baseMint as Address, quote: b.quoteMint as Address, side: b.side, amount: BigInt(b.quantity), owner: b.owner as Address, limitPrice: b.limitPrice === null ? null : BigInt(b.limitPrice), slackTicks: 2, cross: null, salt: null });
      return send(reply, { intent: id, ...out });
    });
  });
}
