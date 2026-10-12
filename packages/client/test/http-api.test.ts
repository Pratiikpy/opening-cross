import { describe, expect, it } from 'vitest';
import { ActionError, createApiClient, fetchJson, retryDelayMs } from '../src/index.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

describe('fetchJson', () => {
  it('retries 429 and 503 and returns the first success', async () => {
    const calls: number[] = [];
    const f = (async () => {
      calls.push(1);
      return calls.length === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '3' }) : calls.length === 2 ? json({ error: 'busy' }, 503) : json({ ok: true });
    }) as unknown as typeof fetch;
    const r = await fetchJson<{ ok: boolean }>('http://x/y', undefined, { fetch: f, sleep: noSleep });
    expect(r).toEqual({ ok: true, data: { ok: true }, status: 200 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a refusal that repeating cannot fix', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return json({ error: 'cross not found' }, 404);
    }) as unknown as typeof fetch;
    const r = await fetchJson('http://x/y', undefined, { fetch: f, sleep: noSleep });
    expect(r).toMatchObject({ ok: false, status: 404, error: 'cross not found' });
    expect(calls).toBe(1);
  });

  it('reports an unreachable server as status 0 after the attempts are spent', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchJson('http://x/y', undefined, { fetch: f, sleep: noSleep, attempts: 3 })).toMatchObject({ ok: false, status: 0 });
    expect(calls).toBe(3);
  });

  it('waits at least what Retry-After asks, and never more than fifteen seconds', () => {
    expect(retryDelayMs(1, '5', 0)).toBe(5_000);
    expect(retryDelayMs(1, null, 0)).toBe(400);
    expect(retryDelayMs(10, null, 0)).toBe(8_000);
    expect(retryDelayMs(1, '999', 0.99)).toBe(15_000);
  });
});

describe('api client', () => {
  const make = (handler: (url: string, init?: RequestInit) => Response) => createApiClient({ baseUrl: 'http://api.test/', fetch: (async (u: string, i?: RequestInit) => handler(String(u), i)) as unknown as typeof fetch, sleep: noSleep });

  it('reads a cross and throws the API’s own sentence on refusal, with a stable code', async () => {
    const api = make((url) => (url.endsWith('/v1/crosses/good') ? json({ address: 'good' }) : json({ error: 'cross nope not found on chain' }, 404)));
    expect(await api.getCross('good')).toEqual({ address: 'good' });
    await expect(api.getCross('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'cross nope not found on chain' });
  });

  it('maps statuses to codes: 400 invalid input, 409 conflict, 429 rate limited, unreachable', async () => {
    const status = (s: number) => make(() => json({ error: 'x' }, s));
    await expect(status(400).tx.cancel({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(status(409).tx.cancel({})).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(status(429).tx.cancel({})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const down = createApiClient({ baseUrl: 'http://x', fetch: (async () => { throw new TypeError('nope'); }) as unknown as typeof fetch, sleep: noSleep, attempts: 1 });
    await expect(down.stats()).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
    await expect(down.stats()).rejects.toBeInstanceOf(ActionError);
  });

  it('normalises a builder answer to transactions plus the extra fields', async () => {
    const one = make(() => json({ transaction: 'AAAA', signers: ['S'], order: 'O' }));
    expect(await one.tx.placeOrder({})).toEqual({ transactions: [{ transaction: 'AAAA', signers: ['S'] }], extra: { order: 'O' } });
    const many = make(() => json({ transactions: [{ transaction: 'A', signers: [] }, { transaction: 'B', signers: [] }], cross: 'C' }));
    const built = await many.tx.createCross({});
    expect(built.transactions).toHaveLength(2);
    expect(built.extra).toEqual({ cross: 'C' });
  });

  it('lists owner orders and batches order lookups, skipping the request when there is nothing to look up', async () => {
    const seen: string[] = [];
    const api = make((url) => {
      seen.push(url);
      return json({ orders: [] });
    });
    expect(await api.orders([])).toEqual([]);
    expect(seen).toHaveLength(0);
    await api.orders(['a', 'b']);
    await api.ownerOrders('me');
    await api.listCrosses({ state: 'Live', limit: 5 });
    expect(seen).toEqual(['http://api.test/v1/orders?addresses=a%2Cb', 'http://api.test/v1/owners/me/orders', 'http://api.test/v1/crosses?state=Live&limit=5']);
  });

  it('answers a missing router as unavailable but still throws a refusal of the request itself', async () => {
    expect(await make(() => json({ error: 'no such route' }, 404)).routeQuote({ cross: 'c', side: 'buy', quantity: '1' })).toMatchObject({ status: 'unavailable' });
    expect(await make(() => json({ error: 'nope' }, 501)).routeQuote({ cross: 'c', side: 'buy', quantity: '1' })).toMatchObject({ status: 'unavailable' });
    expect(await make(() => json({ schema: 'opening-cross/best-execution/v2' })).routeQuote({ cross: 'c', side: 'buy', quantity: '1' })).toEqual({ status: 'ready', report: { schema: 'opening-cross/best-execution/v2' } });
    await expect(make(() => json({ error: 'cross is not accepting orders' }, 409)).routeQuote({ cross: 'c', side: 'buy', quantity: '1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
