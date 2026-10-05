// API contract (ROADMAP D3). A whole sealed cross is run through the API alone: every
// transaction is built by the API, signed by the user's own key exactly as a wallet would, and
// landed on LiteSVM; the indexer ingests what landed; reads, the fairness proof and the
// WebSocket stream are checked against chain. Then the careless and hostile calls: missing,
// malformed and out-of-range fields, unknown accounts, reused nonces, wrong states, oversized
// bodies — each must be refused with a precise error and no transaction.
import { describe, expect, it } from 'vitest';
import type { Address, KeyPairSigner } from '@solana/kit';
import pg from 'pg';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { buildServer } from '@opening-cross/api';
import { Disclosure } from '@opening-cross/sdk';
import { ingestTransaction } from '@opening-cross/indexer';
import { freshDb } from '../src/db.js';
import { World, SCALE } from '../src/world.js';
import { T0 } from '../src/harness.js';

describe.skipIf(!process.env.DATABASE_URL)('API', () => {
  it('runs a sealed cross end to end through unsigned transactions, with reads, proof and stream', async () => {
    const { db, client } = await freshDb();
    const w = await World.create();
    let ingested = 0;
    const sync = async () => {
      for (; ingested < w.h.landed.length; ingested++) await ingestTransaction(db, w.h.landed[ingested]!);
    };
    await sync();
    const app = await buildServer({
      db,
      network: 'localnet',
      account: async (a) => { const x = w.h.svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; },
      lifetime: async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }),
      listen: client,
    });
    const port = await app.listen({ port: 0, host: '127.0.0.1' }).then((u) => Number(new URL(u).port));
    const stream: { name: string; cross: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`);
    await new Promise((r) => ws.once('message', r)); // "subscribed"
    ws.on('message', (m) => { const e = JSON.parse(String(m)); if (e.type === 'event') stream.push({ name: e.name, cross: e.cross }); });

    const post = async (url: string, payload: unknown) => {
      const r = await app.inject({ method: 'POST', url, payload: payload as object });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    };
    const land = async (tx: { transaction: string }, signer: KeyPairSigner) => { await w.h.sendWire(tx.transaction, [signer]); await sync(); };

    // Issuer creates a sealed cross through the API.
    const create = await post('/v1/tx/create-cross', {
      creator: w.creator.address, baseMint: w.baseMint, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId: '77', kind: 'launch', supplyMode: 'escrow', disclosure: 'sealed', minPrice: '1000000', tick: '100000', ticks: 20, priceScale: SCALE.toString(),
      openTs: T0.toString(), closeTs: (T0 + 100n).toString(), revealEndTs: (T0 + 200n).toString(), integratorFeeBps: 20, integrator: w.integrator.address,
      shards: 2, maxOrders: 64, proceedsTo: w.creator.address,
    });
    expect(create.status).toBe(200);
    expect(create.body.transactions).toHaveLength(3);
    for (const t of create.body.transactions) {
      expect(t.signers).toEqual([w.creator.address]);
      await land(t, w.creator);
    }
    const cross = create.body.cross as Address;
    w.h.setTime(T0);

    // Traders bid and offer with their own salts.
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const orders = [
      { who: seller, side: 'sell', price: '1100000', quantity: '2000000000', nonce: '1', salt: randomBytes(32).toString('hex') },
      { who: buyer, side: 'buy', price: '1300000', quantity: '1000000000', nonce: '1', salt: randomBytes(32).toString('hex') },
    ];
    for (const o of orders) {
      const r = await post('/v1/tx/place-order', { cross, owner: o.who.address, side: o.side, price: o.price, quantity: o.quantity, nonce: o.nonce, salt: o.salt });
      expect(r.status).toBe(200);
      await land(r.body, o.who);
    }
    // Reusing a nonce is refused before any transaction is built.
    expect((await post('/v1/tx/place-order', { cross, owner: buyer.address, side: 'buy', price: '1300000', quantity: '1', nonce: '1', salt: orders[1]!.salt })).status).toBe(409);

    w.h.setTime(T0 + 101n);
    for (const o of orders) {
      const r = await post('/v1/tx/reveal', { cross, owner: o.who.address, nonce: o.nonce, price: o.price, quantity: o.quantity, salt: o.salt });
      expect(r.status).toBe(200);
      await land(r.body, o.who);
    }

    // Anyone settles; here a third party pays.
    w.h.setTime(T0 + 201n);
    const cranker = await w.h.wallet();
    const settle = await post('/v1/tx/settle', { cross, payer: cranker.address });
    expect(settle.status).toBe(200);
    for (const t of settle.body.transactions) await land(t, cranker);
    const settled = await app.inject({ url: `/v1/crosses/${cross}` }).then((r) => JSON.parse(r.body));
    expect(settled.state).toBe('Cleared');
    expect(settled.clearing.matched).toBe('1000000000');
    expect(settled.baseMint).toBe(w.baseMint);

    for (const o of orders) {
      const r = await post('/v1/tx/claim', { cross, owner: o.who.address, nonce: o.nonce, payer: cranker.address });
      expect(r.status).toBe(200);
      await land(r.body, cranker);
    }
    expect(await w.h.balanceOf(buyer.address, w.baseMint)).toBe(1_000_000_000n);
    const fin = await post('/v1/tx/finalize', { cross, payer: cranker.address });
    await land(fin.body, cranker);

    const final = await app.inject({ url: `/v1/crosses/${cross}` }).then((r) => JSON.parse(r.body));
    expect(final.state).toBe('Finalized');
    const proof = await app.inject({ url: `/v1/crosses/${cross}/proof` }).then((r) => JSON.parse(r.body));
    expect(proof.verified).toBe(true);
    const list = await app.inject({ url: `/v1/crosses/${cross}/orders` }).then((r) => JSON.parse(r.body));
    expect(list.orders.map((o: { status: string; side: string }) => `${o.side}:${o.status}`)).toEqual(['sell:claimed', 'buy:claimed']);
    const mine = await app.inject({ url: `/v1/owners/${buyer.address}/orders` }).then((r) => JSON.parse(r.body));
    expect(mine.orders[0].fill).toBe('1000000000');
    const crosses = await app.inject({ url: '/v1/crosses?state=Finalized' }).then((r) => JSON.parse(r.body));
    expect(crosses.crosses.map((c: { address: string }) => c.address)).toEqual([cross]);
    const stats = await app.inject({ url: '/v1/stats' }).then((r) => JSON.parse(r.body));
    expect(stats).toMatchObject({ network: 'localnet', crosses_printed: 1, crosses_total: 1, buyers_filled: 1, crosses_no_print: 0 });
    expect(BigInt(stats.quote_to_sellers)).toBeGreaterThan(0n);
    const health = await app.inject({ url: '/v1/health' });
    expect(health.statusCode).toBe(200);

    // The stream delivered every event of the lifecycle, in order.
    for (let waited = 0; stream.filter((e) => e.cross === cross).length < 9 && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    expect(stream.filter((e) => e.cross === cross).map((e) => e.name)).toEqual([
      'CrossCreated', 'OrderCommitted', 'OrderCommitted', 'OrderRevealed', 'OrderRevealed', 'CrossCleared', 'OrderClaimed', 'OrderClaimed', 'CrossFinalized',
    ]);

    // ---- careless and hostile calls
    const bad = async (url: string, payload: unknown, status: number, match: RegExp) => {
      const r = await app.inject({ method: 'POST', url, payload: payload as object, headers: { 'content-type': 'application/json' } });
      expect(r.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(status);
      expect(JSON.parse(r.body).error).toMatch(match);
      expect(r.body).not.toContain('transaction');
    };
    await bad('/v1/tx/place-order', {}, 400, /cross must be a base58/);
    await bad('/v1/tx/place-order', [], 400, /JSON object/);
    await bad('/v1/tx/place-order', { cross: 'not-an-address' }, 400, /cross must be/);
    await bad('/v1/tx/place-order', { cross: (await w.h.wallet()).address.replace(/./, (c) => (c === '2' ? '3' : '2')) }, 404, /not found on chain/);
    await bad('/v1/tx/place-order', { cross: buyer.address }, 404, /not an Opening Cross account/);
    // A byte-for-byte copy of the cross under another program is not a cross.
    const forged = (await w.h.wallet()).address;
    const real = w.h.svm.getAccount(cross);
    if (!real.exists) throw new Error('cross missing');
    w.h.svm.setAccount({ ...real, address: forged, programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    expect((await app.inject({ url: `/v1/crosses/${forged}` })).statusCode).toBe(404);
    expect(JSON.parse((await app.inject({ url: `/v1/crosses/${forged}/proof` })).body).error).toMatch(/not an Opening Cross account/);
    await bad('/v1/tx/place-order', { cross }, 409, /not accepting orders/);
    await bad('/v1/tx/claim', { cross, owner: buyer.address, nonce: '1' }, 409, /finalized/);
    await bad('/v1/tx/cancel', { cross, owner: buyer.address, nonce: '9' }, 404, /no open order/);
    await bad('/v1/tx/settle', { cross, payer: cranker.address }, 409, /already settled/);
    await bad('/v1/tx/create-cross', { creator: w.creator.address }, 400, /quoteMint/);
    await bad('/v1/tx/create-cross', { creator: w.creator.address, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, crossId: '-1' }, 400, /crossId must be/);
    await bad('/v1/tx/create-cross', { creator: w.creator.address, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, crossId: '18446744073709551616' }, 400, /crossId must be/);
    await bad('/v1/tx/create-cross', { creator: w.creator.address, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, crossId: '1', kind: 'auction' }, 400, /kind must be one of/);
    const big = await app.inject({ method: 'POST', url: '/v1/tx/place-order', payload: JSON.stringify({ pad: 'x'.repeat(70_000) }), headers: { 'content-type': 'application/json' } });
    expect(big.statusCode).toBe(413);
    expect((await app.inject({ url: '/v1/crosses/xyz' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/crosses?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/crosses?state=Open' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/nope' })).statusCode).toBe(404);
    // Wallet flows run in the browser: a cross-origin preflight must be allowed.
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/tx/place-order', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect((await app.inject({ url: `/v1/crosses/${w.quoteMint}` })).statusCode).toBe(404);

    ws.close();
    await app.close();
    await db.end();
  }, 60_000);

  it('creates a minting cross with one issuer signature that also hands over the mint authority', async () => {
    const { db } = await freshDb();
    const w = await World.create();
    const app = await buildServer({ db, account: async (a) => { const x = w.h.svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; }, lifetime: async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }) });
    const base = await w.h.mint(w.creator, 6); // the issuer holds the mint authority
    const r = await app.inject({ method: 'POST', url: '/v1/tx/create-cross', payload: {
      creator: w.creator.address, baseMint: base, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId: '5', kind: 'launch', supplyMode: 'mint', disclosure: 'open', minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000',
      openTs: T0.toString(), closeTs: (T0 + 100n).toString(), revealEndTs: (T0 + 100n).toString(), integrator: w.integrator.address,
      shards: 1, maxOrders: 16, proceedsTo: w.creator.address, schedule: [{ price: '1200000', quantity: '1000000000' }],
    } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { cross: string; transactions: { transaction: string }[] };
    for (const t of body.transactions) await w.h.sendWire(t.transaction, [w.creator]);
    expect(w.h.mintInfo(base).mintAuthority).toEqual({ __option: 'Some', value: body.cross });
    expect(w.view(body.cross as never).data.supplyMode).toBe(1);
    await app.close();
    await db.end();
  });

  it('refuses a sealed order without a salt, and a stream filter that is not an address', async () => {
    const { db } = await freshDb();
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Sealed });
    const app = await buildServer({ db, account: async (a) => { const x = w.h.svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; }, lifetime: async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1n }) });
    const buyer = await w.trader(1_000_000_000n);
    const r = await app.inject({ method: 'POST', url: '/v1/tx/place-order', payload: { cross: cross.address, owner: buyer.address, side: 'buy', price: '1300000', quantity: '1000', nonce: '0' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/salt/);
    const port = await app.listen({ port: 0, host: '127.0.0.1' }).then((u) => Number(new URL(u).port));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?cross=bogus`);
    const first = await new Promise<string>((res) => ws.once('message', (m) => res(String(m))));
    expect(JSON.parse(first).error).toMatch(/base58/);
    await new Promise((res) => ws.once('close', res));
    await app.close();
    await db.end();
  });
});
