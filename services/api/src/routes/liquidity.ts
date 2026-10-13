// Off-chain liquidity routes (PRODUCT_FEATURES W7, W9, Z7). Everything stored here is a document its author signed; what the
// routes add is checking the signature, checking the claim against the chain, and measuring a maker from the orders the
// indexer holds. Nothing here moves money: orders, escrow and fills are cross_core's.
//
//   POST /v1/liquidity/makers              a signed registration           201 { maker } | 400 | 409 stale
//   GET  /v1/liquidity/makers              every registered maker with its obligation
//   GET  /v1/liquidity/makers/:maker       the registration, the obligation measured over its recent crosses and the
//                                          rebate it earned on finalized reopens (the company's own wallets earn none)
//   POST /v1/liquidity/quotes              a signed quote; stored only if its order is resting on chain as quoted
//   GET  /v1/liquidity/quotes?cross=       the unexpired quotes of a cross, each re-checked against the chain now
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, getCrossDecoder } from '@opening-cross/sdk';
import {
  type MakerOrderFact,
  type SignedQuote,
  type SignedRegistration,
  checkBacking,
  crossCompliance,
  rebatePoolOf,
  splitRebate,
  verifyQuote,
  verifyRegistration,
} from '@opening-cross/liquidity';
import { RequestError } from '../tx.js';

export type LiquidityDeps = {
  db: pg.Pool;
  account: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
  clock?: () => number;
  /** Wallets the company operates: measured like anyone, never paid from the rebate pool (Y7). */
  ownWallets?: ReadonlySet<string>;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;
/** Crosses looked at when measuring a maker. */
const WINDOW_CROSSES = 50;
/** Quotes read from the database per request, and chain reads in flight (reads within a few ms share one RPC call). */
const QUOTES_MAX = 200;

function bodyOf(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'request body must be a JSON object');
  return v as Record<string, unknown>;
}

type MakerRow = { maker: string; name: string; min_quantity: string; max_spread_bps: number; registered_at: Date };
const makerOut = (r: MakerRow) => ({ maker: r.maker, name: r.name, obligation: { minQuantity: r.min_quantity, maxSpreadBps: r.max_spread_bps }, registeredAt: r.registered_at });

export function registerLiquidity(app: FastifyInstance, d: LiquidityDeps): void {
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const own = d.ownWallets ?? new Set<string>();

  app.post('/v1/liquidity/makers', async (req, reply) => {
    const doc = bodyOf(req.body) as unknown as SignedRegistration;
    if (!(await verifyRegistration(doc))) throw new RequestError(400, 'the registration is malformed or its signature does not match the maker');
    const b = doc.body;
    // A later registration replaces an earlier one; an older document cannot overwrite a newer one.
    const res = await d.db.query(
      `INSERT INTO liquidity_makers (maker, name, min_quantity, max_spread_bps, registration)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (maker) DO UPDATE SET name = EXCLUDED.name, min_quantity = EXCLUDED.min_quantity, max_spread_bps = EXCLUDED.max_spread_bps, registration = EXCLUDED.registration, registered_at = now()
       WHERE (liquidity_makers.registration->'body'->>'issuedAt')::bigint < $6`,
      [b.maker, b.name, b.minQuantity, b.maxSpreadBps, JSON.stringify(doc), b.issuedAt],
    );
    if (res.rowCount === 0) throw new RequestError(409, 'a newer registration for this maker is already stored');
    return send(reply, { maker: b.maker, id: doc.id }, 201);
  });

  app.get('/v1/liquidity/makers', async (_req, reply) => {
    const { rows } = await d.db.query<MakerRow>('SELECT maker, name, min_quantity::text, max_spread_bps, registered_at FROM liquidity_makers ORDER BY registered_at');
    return send(reply, { makers: rows.map((r) => ({ ...makerOut(r), operatedByUs: own.has(r.maker) })) });
  });

  app.get('/v1/liquidity/makers/:maker', async (req, reply) => {
    const maker = (req.params as { maker: string }).maker;
    if (!isAddress(maker)) throw new RequestError(400, 'maker must be a base58 Solana address');
    const reg = (await d.db.query<MakerRow>('SELECT maker, name, min_quantity::text, max_spread_bps, registered_at FROM liquidity_makers WHERE maker = $1', [maker])).rows[0];
    if (!reg) throw new RequestError(404, `${maker} is not a registered market maker`);
    const rule = { minQuantity: BigInt(reg.min_quantity), maxSpreadBps: reg.max_spread_bps };

    // The maker's most recent crosses that have closed, with every order it placed in them.
    const crosses = (
      await d.db.query<{ address: string; kind: number; state: string; protocol_fee: string | null }>(
        `SELECT c.address, c.kind, c.state, c.protocol_fee::text
           FROM crosses c WHERE c.address IN (SELECT DISTINCT cross_address FROM orders WHERE owner = $1) AND c.state <> 'Live'
          ORDER BY c.created_slot DESC LIMIT $2`,
        [maker, WINDOW_CROSSES],
      )
    ).rows;
    const orders = crosses.length
      ? (await d.db.query<{ cross_address: string; side: number; price: string | null; quantity: string | null; status: MakerOrderFact['status'] }>(
          'SELECT cross_address, side, price::text, quantity::text, status FROM orders WHERE owner = $1 AND cross_address = ANY($2::text[]) AND price IS NOT NULL', [maker, crosses.map((c) => c.address)],
        )).rows
      : [];
    const byCross = new Map<string, MakerOrderFact[]>();
    for (const o of orders) {
      const list = byCross.get(o.cross_address) ?? [];
      list.push({ side: o.side === 0 ? 'buy' : 'sell', price: BigInt(o.price!), quantity: BigInt(o.quantity!), status: o.status });
      byCross.set(o.cross_address, list);
    }

    // Price scale is read from the cross account once per cross (batched by the account reader).
    const scales = await Promise.all(crosses.map(async (c) => {
      const acct = await d.account(c.address as Address);
      if (!acct) return null;
      return getCrossDecoder().decode(acct.data).priceScale;
    }));

    let compliant = 0;
    const perCross = crosses.map((c, i) => {
      const scale = scales[i];
      if (scale == null) return { cross: c.address, state: c.state, measured: false as const, reason: 'the cross account could not be read from chain' };
      const r = crossCompliance(byCross.get(c.address) ?? [], rule, scale);
      if (r.compliant) compliant++;
      return { cross: c.address, state: c.state, measured: true as const, compliant: r.compliant, spreadBps: r.spreadBps, buyQuantity: r.buyQuantity, sellQuantity: r.sellQuantity, reasons: r.reasons };
    });

    // The rebate this maker earned on finalized reopen crosses, against every other registered maker's weight on the same cross.
    const reopen = crosses.filter((c) => c.state === 'Finalized' && KINDS[c.kind] === 'reopen' && c.protocol_fee !== null);
    let rebate = 0n;
    const rebatePerCross: { cross: string; pool: bigint; share: bigint }[] = [];
    if (own.has(maker)) {
      // Our own market-maker bot is paid from its own budget, never from the pool.
    } else {
      for (const c of reopen) {
        const idx = crosses.indexOf(c);
        const scale = scales[idx];
        if (scale == null) continue;
        const pool = rebatePoolOf('reopen', BigInt(c.protocol_fee!));
        const peers = (await d.db.query<{ owner: string; side: number; price: string; quantity: string; status: MakerOrderFact['status']; min_quantity: string; max_spread_bps: number }>(
          `SELECT o.owner, o.side, o.price::text, o.quantity::text, o.status, m.min_quantity::text, m.max_spread_bps
             FROM orders o JOIN liquidity_makers m ON m.maker = o.owner WHERE o.cross_address = $1 AND o.price IS NOT NULL`, [c.address],
        )).rows;
        const grouped = new Map<string, { rule: { minQuantity: bigint; maxSpreadBps: number }; orders: MakerOrderFact[] }>();
        for (const p of peers) {
          if (own.has(p.owner)) continue;
          const g = grouped.get(p.owner) ?? { rule: { minQuantity: BigInt(p.min_quantity), maxSpreadBps: p.max_spread_bps }, orders: [] };
          g.orders.push({ side: p.side === 0 ? 'buy' : 'sell', price: BigInt(p.price), quantity: BigInt(p.quantity), status: p.status });
          grouped.set(p.owner, g);
        }
        const weights = new Map([...grouped.entries()].map(([m, g]) => [m, crossCompliance(g.orders, g.rule, scale).weight] as const));
        const share = splitRebate(pool, weights).shares.get(maker) ?? 0n;
        rebatePerCross.push({ cross: c.address, pool, share });
        rebate += share;
      }
    }

    return send(reply, {
      ...makerOut(reg),
      operatedByUs: own.has(maker),
      measured: { crosses: perCross.length, compliant, window: WINDOW_CROSSES, perCross },
      rebate: {
        note: own.has(maker)
          ? 'This wallet is operated by the company; it is paid from its own budget and receives no rebate.'
          : 'The share of the rebate pool (25% of the protocol fee on a finalized reopen) that this maker earned, in proportion to its two-sided liquidity that met its obligation. Paying it out is a transfer from the protocol fee wallet; this route measures, it does not pay.',
        quoteAtoms: rebate,
        reopenCrossesCounted: rebatePerCross.length,
        perCross: rebatePerCross,
      },
    });
  });

  app.post('/v1/liquidity/quotes', async (req, reply) => {
    const doc = bodyOf(req.body) as unknown as SignedQuote;
    const t = now();
    const v = await verifyQuote(doc, t);
    if (!v.ok) throw new RequestError(400, `the quote is not valid: ${v.reason}`, { reason: v.reason });
    const backing = await checkBacking(doc, d.account, CROSS_CORE_PROGRAM_ADDRESS as Address);
    if (!backing.backed) throw new RequestError(422, `the quoted order is not resting on chain as quoted: ${backing.detail}`, { reason: backing.reason });
    const b = doc.body;
    await d.db.query(
      `INSERT INTO liquidity_quotes (id, cross_address, maker, side, price, quantity, order_nonce, expires_at, quote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [doc.id, b.cross, b.maker, b.side, b.price, b.quantity, b.orderNonce, b.expiresAt, JSON.stringify(doc)],
    );
    return send(reply, { id: doc.id, remaining: backing.remaining }, 201);
  });

  app.get('/v1/liquidity/quotes', async (req, reply) => {
    const cross = (req.query as { cross?: string }).cross;
    if (!cross || !isAddress(cross)) throw new RequestError(400, 'cross must be a base58 Solana address');
    const t = now();
    const rows = (await d.db.query<{ quote: SignedQuote }>('SELECT quote FROM liquidity_quotes WHERE cross_address = $1 AND expires_at > $2 ORDER BY expires_at DESC LIMIT $3', [cross, t, QUOTES_MAX])).rows;
    const out = await Promise.all(rows.map(async ({ quote }) => {
      const backing = await checkBacking(quote, d.account, CROSS_CORE_PROGRAM_ADDRESS as Address);
      return { id: quote.id, maker: quote.body.maker, side: quote.body.side, price: quote.body.price, quantity: quote.body.quantity, expiresAt: quote.body.expiresAt, backing: backing.backed ? { backed: true, remaining: backing.remaining } : { backed: false, reason: backing.reason, detail: backing.detail } };
    }));
    const live = out.filter((q) => q.backing.backed);
    return send(reply, {
      cross,
      note: 'A quote is a signed pointer to an order that rests on chain. Each is re-read from chain for this response; cancelling an order is free, so a quote is evidence of liquidity now, not a promise.',
      quotes: live,
      withdrawn: out.length - live.length,
    });
  });
}
