// Opening Cross API.
//
// Reads: the indexer's tables answer lists and history; anything a user acts on (a cross's state,
// clearing, an order) is read from chain in the same request, so the API never shows a stale
// state as current. Writes: unsigned transactions only (see tx.ts). Stream: every ingested event,
// pushed over WebSocket as the indexer commits it.
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, ORDER_DISCRIMINATOR, OrderSide, getCrossDecoder, getOrderDecoder } from '@opening-cross/sdk';
import { verifyCross } from '@opening-cross/verifier';
import { type Lifetime, RequestError, cancelTx, claimTx, createCrossTxs, finalizeTx, placeOrderTx, revealTx, settleTxs } from './tx.js';

export type ChainAccount = { data: Uint8Array; owner: Address };

export type ApiDeps = {
  db: pg.Pool;
  /** Reads an account with its owning program, or null if it does not exist. */
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** A dedicated connection for LISTEN; the API owns it once passed. */
  listen?: () => Promise<pg.Client>;
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
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return send(reply, { error: err.message }, err.status);
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return send(reply, { error: e.message ?? 'bad request' }, e.statusCode);
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
    const { rows } = await d.db.query(`SELECT (SELECT max(last_slot) FROM cursors) AS slot, (SELECT count(*)::int FROM reconciliation_alerts WHERE at > now() - interval '1 hour') AS alerts`);
    const ok = rows[0].alerts === 0;
    return send(reply, { ok, indexedSlot: rows[0].slot, recentDriftAlerts: rows[0].alerts }, ok ? 200 : 503);
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
    return send(reply, present(a, v.data));
  });

  app.get('/v1/crosses/:address/orders', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    const { rows } = await d.db.query(
      `SELECT idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee FROM orders WHERE cross_address = $1 ORDER BY idx`,
      [a],
    );
    return send(reply, { orders: rows.map((r) => ({ ...r, side: r.side === 0 ? 'buy' : 'sell' })) });
  });

  app.get('/v1/crosses/:address/proof', async (req, reply) => {
    const a = address((req.params as { address: string }).address, 'address');
    await crossView(a);
    return send(reply, await verifyCross(fetchOwned, a));
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
    const out = await createCrossTxs(
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
      } as Parameters<typeof createCrossTxs>[0],
      await d.lifetime(),
    );
    return send(reply, out);
  });

  // ---------------------------------------------------------------- stream
  // One LISTEN connection fans out to every socket; a socket may filter to one cross.
  const sockets = new Set<{ cross: string | null; send: (s: string) => void }>();
  if (d.listen) {
    const client = await d.listen();
    await client.query('LISTEN opening_cross_events');
    client.on('notification', async (n) => {
      const key = JSON.parse(n.payload ?? '{}') as { signature: string; seq: number };
      const { rows } = await d.db.query('SELECT signature, seq, slot, name, cross_address AS cross, payload FROM events WHERE signature = $1 AND seq = $2', [key.signature, key.seq]);
      const ev = rows[0];
      if (!ev) return;
      const msg = json({ type: 'event', ...ev });
      for (const s of sockets) if (s.cross === null || s.cross === ev.cross) s.send(msg);
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
