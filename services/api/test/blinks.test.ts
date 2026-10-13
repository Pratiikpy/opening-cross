// Solana Actions endpoints: the GET metadata, the POST transaction, the CORS headers the specification requires, and the careless
// states (closed, upcoming, sealed, gated, off-grid price, no account). The transaction is decoded and checked, not just returned.
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { CrossState, Disclosure } from '@opening-cross/sdk';
import { registerBlinks } from '../src/routes/blinks.js';
import { Chain, newAddress } from './helpers/w2a.js';

const NOW = 1_800_000_000;
const chain = new Chain();
let app: FastifyInstance;
let account: string;

const open = (over: Record<string, unknown> = {}) =>
  chain.putCross({ state: CrossState.Live, disclosure: Disclosure.Open, openTs: BigInt(NOW - 100), closeTs: BigInt(NOW + 3_700), minPrice: 1_000_000n, tick: 50_000n, ticks: 41, baseDecimals: 6, quoteDecimals: 6, protocolFeeBps: 5, integratorFeeBps: 20, ...over });

beforeAll(async () => {
  account = await newAddress();
  app = Fastify();
  registerBlinks(app, { account: chain.read, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never, lastValidBlockHeight: 1n }), clock: () => NOW, network: 'devnet' });
  await app.ready();
});

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url });
  return { status: r.statusCode, headers: r.headers, body: JSON.parse(r.body) };
};
const post = async (url: string, body: unknown) => {
  const r = await app.inject({ method: 'POST', url, payload: body as object });
  return { status: r.statusCode, headers: r.headers, body: JSON.parse(r.body) };
};
const order = (cross: string, q: string) => `/v1/blinks/cross/${cross}/order?${q}`;

describe('actions.json, icon and CORS', () => {
  it('maps the app\'s cross URLs to the Action and allows any origin on every endpoint', async () => {
    const r = await get('/actions.json');
    expect(r.body.rules).toContainEqual({ pathPattern: '/crosses/*', apiPath: '/v1/blinks/cross/*' });
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/blinks/cross/anything' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toBe('GET,POST,PUT,OPTIONS');
    expect(pre.headers['access-control-allow-headers']).toContain('Content-Type, Authorization, Content-Encoding, Accept-Encoding');
    const icon = await app.inject({ method: 'GET', url: '/v1/blinks/icon.svg' });
    expect(icon.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(icon.body).toContain('<svg');
  });
});

describe('GET an open cross', () => {
  it('describes the call in plain words with a buy button per preset and a custom form', async () => {
    const cross = await open();
    const r = await get(`/v1/blinks/cross/${cross}`);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.body).toMatchObject({ type: 'action', title: 'Opening Bell: a call auction' });
    expect(r.body.icon).toMatch(/^https?:\/\/.+\/v1\/blinks\/icon\.svg$/);
    expect(r.body.description).toContain('It closes in 1h 01m 40s');
    expect(r.body.description).toContain('Prices run from 1 to 3 per token');
    expect(r.body.description).toContain('Every filled order pays the same clearing price');
    const actions = r.body.links.actions as { label: string; href: string; parameters: { name: string }[] }[];
    expect(actions.map((a) => a.label)).toEqual(['Buy 1', 'Buy 10', 'Buy 100', 'Place order']);
    expect(actions[0]!.href).toBe(`/v1/blinks/cross/${cross}/order?side=buy&price={price}&quantity=1`);
    expect(actions[3]!.parameters.map((p) => p.name)).toEqual(['side', 'price', 'quantity']);
    expect(r.body.disabled).toBeUndefined();
  });

  it('shows a disabled button with the reason when the call is closed, upcoming, sealed or gated', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ closeTs: BigInt(NOW - 5) }, 'Closed', 'This call has closed.'],
      [{ state: CrossState.Cleared }, 'Closed', 'This call has closed.'],
      [{ openTs: BigInt(NOW + 500) }, 'Not available here', 'has not opened yet'],
      [{ disclosure: Disclosure.Sealed }, 'Not available here', 'sealed'],
      [{ gateMint: { __option: 'Some', value: await newAddress() } }, 'Not available here', 'pass'],
    ];
    for (const [over, label, reason] of cases) {
      const r = await get(`/v1/blinks/cross/${await open(over)}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ disabled: true, label });
      expect(r.body.error.message).toContain(reason);
      expect(r.body.links).toBeUndefined();
    }
  });

  it('answers a bad or unknown address with an ActionError, never a stack trace', async () => {
    const r = await get('/v1/blinks/cross/not-an-address');
    expect(r).toMatchObject({ status: 400, body: { message: expect.stringContaining('not a cross address') } });
    const none = await get(`/v1/blinks/cross/${await newAddress()}`);
    expect(none).toMatchObject({ status: 404, body: { message: expect.stringContaining('No Opening Cross') } });
  });
});

describe('POST an order', () => {
  it('returns an unsigned transaction whose fee payer is the account, with the whole story in the message', async () => {
    const cross = await open();
    const r = await post(order(cross, 'side=buy&price=1.6&quantity=10'), { account });
    expect(r.status).toBe(200);
    expect(r.body.message).toContain('Bid for 10 tokens at up to 1.6 each');
    expect(r.body.message).toContain('16 leaves your wallet now');
    expect(r.body.message).toContain('No fee for buyers');
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(r.body.transaction));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(message.staticAccounts[0]).toBe(account); // the fee payer
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true); // nothing is signed
    expect(message.header.numSignerAccounts).toBe(1); // only the account can sign
  });

  it('prices a sell with the fee and refuses bad input with the grid in the message', async () => {
    const cross = await open();
    const sell = await post(order(cross, 'side=sell&price=1.5&quantity=2.5'), { account });
    expect(sell.status).toBe(200);
    expect(sell.body.message).toContain('Offer 2.5 tokens at no less than 1.5 each');
    expect((await post(order(cross, 'side=buy&price=1.5&quantity=1'), { account })).body.message).toContain('Bid for 1 token at up to');
    expect(sell.body.message).toContain('The fee is 0.25% of what you receive');
    const off = await post(order(cross, 'side=buy&price=1.62&quantity=1'), { account });
    expect(off).toMatchObject({ status: 400, body: { message: 'The price must be between 1 and 3, in steps of 0.05.' } });
    expect((await post(order(cross, 'side=buy&price=9&quantity=1'), { account })).status).toBe(400);
    expect((await post(order(cross, 'side=buy&price=abc&quantity=1'), { account })).body.message).toMatch(/Enter a price per token between 1 and 3/);
    expect((await post(order(cross, 'side=buy&price=1.5&quantity=0'), { account })).body.message).toMatch(/greater than zero/);
    expect((await post(order(cross, 'side=buy&price=1.5&quantity=1.1234567'), { account })).body.message).toMatch(/at most 6 decimal places/);
    expect((await post(order(cross, 'side=hold&price=1.5&quantity=1'), { account })).body.message).toBe('Choose buy or sell.');
  });

  it('refuses without an account, for a closed, upcoming, sealed or gated call, and nothing is built', async () => {
    const cross = await open();
    for (const body of [{}, { account: 'nope' }, null, { account: 5 }]) {
      const r = await post(order(cross, 'side=buy&price=1.5&quantity=1'), body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.message).toContain('did not send an account');
    }
    const before = chain.reads.length;
    expect((await post(order(await open({ closeTs: BigInt(NOW - 1) }), 'side=buy&price=1.5&quantity=1'), { account })).body.message).toMatch(/closed. Nothing was sent/);
    expect((await post(order(await open({ openTs: BigInt(NOW + 9) }), 'side=buy&price=1.5&quantity=1'), { account })).status).toBe(409);
    expect((await post(order(await open({ disclosure: Disclosure.Sealed }), 'side=buy&price=1.5&quantity=1'), { account })).body.message).toMatch(/sealed/);
    expect((await post(order(await open({ gateMint: { __option: 'Some', value: await newAddress() } }), 'side=buy&price=1.5&quantity=1'), { account })).body.message).toMatch(/pass/);
    expect(chain.reads.length).toBeGreaterThan(before); // the cross was read; no order account was probed for a refused request
  });

  it('answers the same two orders with different nonces, so a double click is two orders, not a clash', async () => {
    const cross = await open();
    const a = await post(order(cross, 'side=buy&price=1.5&quantity=1'), { account });
    const b = await post(order(cross, 'side=buy&price=1.5&quantity=1'), { account });
    expect(a.body.transaction).not.toBe(b.body.transaction);
  });
});
