// The per-address limiter: the pure window logic, then over HTTP.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createLimiter } from '../src/rate-limit.js';
import { buildServer } from '../src/server.js';

describe('createLimiter', () => {
  it('allows the limit, refuses the next request with a retry time, and starts a new window afterwards', () => {
    let t = 1_000;
    const l = createLimiter({ perWindow: 3, windowMs: 10_000 }, () => t);
    for (let i = 0; i < 3; i++) expect(l.check('a', '/v1/stats').allowed).toBe(true);
    expect(l.check('a', '/v1/stats')).toEqual({ allowed: false, retryAfterSeconds: 10 });
    t += 4_000;
    expect(l.check('a', '/v1/stats')).toEqual({ allowed: false, retryAfterSeconds: 6 });
    t += 6_000;
    expect(l.check('a', '/v1/stats').allowed).toBe(true);
  });

  it('counts each address on its own, never limits exempt paths, and is off at zero', () => {
    const l = createLimiter({ perWindow: 1, exempt: ['/v1/health'] });
    expect(l.check('a', '/v1/stats').allowed).toBe(true);
    expect(l.check('b', '/v1/stats').allowed).toBe(true);
    expect(l.check('a', '/v1/stats').allowed).toBe(false);
    for (let i = 0; i < 20; i++) expect(l.check('a', '/v1/health').allowed).toBe(true);
    const off = createLimiter({ perWindow: 0 });
    for (let i = 0; i < 50; i++) expect(off.check('a', '/v1/stats').allowed).toBe(true);
  });

  it('forgets addresses whose window has ended', () => {
    let t = 0;
    const l = createLimiter({ perWindow: 1, windowMs: 1_000 }, () => t);
    l.check('a', '/x');
    t = 5_000;
    expect(l.check('b', '/x').allowed).toBe(true);
    expect(l.check('a', '/x').allowed).toBe(true);
  });
});

describe('the API with a limit', () => {
  const stats = { crosses_printed: 0, crosses_total: 0, buyers_filled: 0, quote_to_sellers: '0', quote_refunded_to_buyers: '0', crosses_no_print: 0 };
  const db = { query: async () => ({ rows: [stats] }) } as unknown as pg.Pool;
  const lifetime = async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n }) as never;

  it('answers 429 with Retry-After once an address passes its limit, but still serves health and CORS preflights', async () => {
    const app = await buildServer({ db, account: async () => null, lifetime, rateLimit: { perWindow: 2 } });
    const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '203.0.113.7' });
    expect((await get('/v1/stats')).statusCode).toBe(200);
    expect((await get('/v1/stats')).statusCode).toBe(200);
    const refused = await get('/v1/stats');
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.json().error).toMatch(/too many requests/);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/stats', remoteAddress: '203.0.113.7', headers: { origin: 'https://x.example', 'access-control-request-method': 'GET' } });
    expect(preflight.statusCode).toBeLessThan(300);
    // Another address is unaffected.
    expect((await app.inject({ method: 'GET', url: '/v1/stats', remoteAddress: '203.0.113.8' })).statusCode).toBe(200);
  });

  it('uses the forwarded address only when told to trust the proxy', async () => {
    const trusting = await buildServer({ db, account: async () => null, lifetime, rateLimit: { perWindow: 1 }, trustProxy: true });
    const hit = (app: typeof trusting, ip: string) => app.inject({ method: 'GET', url: '/v1/stats', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': ip } });
    expect((await hit(trusting, '198.51.100.1')).statusCode).toBe(200);
    expect((await hit(trusting, '198.51.100.2')).statusCode).toBe(200);
    expect((await hit(trusting, '198.51.100.1')).statusCode).toBe(429);
    const plain = await buildServer({ db, account: async () => null, lifetime, rateLimit: { perWindow: 1 } });
    expect((await hit(plain, '198.51.100.1')).statusCode).toBe(200);
    expect((await hit(plain, '198.51.100.2')).statusCode).toBe(429);
  });
});
