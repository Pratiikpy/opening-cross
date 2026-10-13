// GET /v1/crosses/summary: row shaping and the route over HTTP. The route reads one table, so the HTTP half runs against a
// small stand-in for the pool that answers that one query from rows and records the arguments it was given.
import Fastify from 'fastify';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX, registerCrossList, shapeSummary } from '../src/routes/crosslist.js';

const row = (over: Record<string, unknown> = {}) => ({
  address: 'A1',
  state: 'Finalized',
  disclosure: 1,
  supply_mode: 1,
  orders_committed: 3,
  open_ts: '1791775119',
  close_ts: '1791775754',
  reveal_end_ts: '1791775754',
  creator: 'C1',
  base_mint: 'B1',
  quote_mint: 'Q1',
  clearing_price: '1200000',
  matched: '2000000000',
  ...over,
});

describe('shapeSummary', () => {
  it('names the program enums: disclosure 0 is sealed and 1 is open, supply modes in declaration order', () => {
    const out = shapeSummary([row({ disclosure: 0, supply_mode: 0 }), row({ address: 'A2', disclosure: 1, supply_mode: 1 }), row({ address: 'A3', supply_mode: 2 })]);
    expect(out.map((r) => [r.disclosure, r.supplyMode])).toEqual([['sealed', 'escrow'], ['open', 'mint'], ['open', 'deferred-mint']]);
  });

  it('keeps counts, times and a missing clearing price exactly as stored', () => {
    const [r] = shapeSummary([row({ clearing_price: null, matched: null, orders_committed: 0 })]);
    expect(r).toMatchObject({ orders: 0, clearingPrice: null, matched: null, openTs: '1791775119', closeTs: '1791775754' });
  });

  it('refuses an enum value outside the program range instead of guessing', () => {
    expect(() => shapeSummary([row({ disclosure: 2 })])).toThrow(/enum value/);
    expect(() => shapeSummary([row({ supply_mode: 3 })])).toThrow(/enum value/);
  });
});

async function server(rows: ReturnType<typeof row>[]) {
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, args: unknown[]) => (calls.push(args), { rows: rows.slice(0, Number(args[0])) }) } as unknown as pg.Pool;
  const app = Fastify();
  registerCrossList(app, { db });
  // The per-cross route is declared too, to prove the static path wins over `:address`.
  app.get('/v1/crosses/:address', async () => ({ route: 'detail' }));
  return { app, calls };
}

describe('GET /v1/crosses/summary', () => {
  it('serves every row with its count, and wins over /v1/crosses/:address', async () => {
    const { app } = await server([row(), row({ address: 'A2', disclosure: 0 })]);
    const res = await app.inject('/v1/crosses/summary');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const j = res.json();
    expect(j.count).toBe(2);
    expect(j.crosses[1]).toMatchObject({ address: 'A2', disclosure: 'sealed', supplyMode: 'mint' });
    expect((await app.inject('/v1/crosses/A1')).json()).toEqual({ route: 'detail' });
  });

  it('defaults the limit to 1000 and passes a chosen one through', async () => {
    const { app, calls } = await server([row()]);
    await app.inject('/v1/crosses/summary');
    await app.inject('/v1/crosses/summary?limit=7');
    expect(calls).toEqual([[1000], [7]]);
  });

  it.each(['0', '-1', '1.5', 'abc', String(SUMMARY_MAX + 1), ''])('rejects limit=%s with 400 and does not query', async (limit) => {
    const { app, calls } = await server([row()]);
    const res = await app.inject(`/v1/crosses/summary?limit=${limit}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/limit must be an integer/);
    expect(calls).toEqual([]);
  });

  it('serves an empty index as an empty list', async () => {
    const { app } = await server([]);
    expect((await app.inject('/v1/crosses/summary')).json()).toEqual({ count: 0, crosses: [] });
  });
});
