// The whole server as the deployed process builds it: every route group registered together over a Postgres that has run every
// indexer migration in order. A route registered twice, a migration that does not apply on top of the others, or a group that
// cannot start without a real chain would all fail here instead of at deploy.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));

describe('the whole server boots', () => {
  const state: { app?: Awaited<ReturnType<typeof buildServer>> } = {};
  afterAll(async () => {
    await state.app?.close();
  });

  it('registers every route group over every migration, and answers', async () => {
    const pg = new PGlite();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
    const db = { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) as never };
    const app = await buildServer({
      db: db as never,
      network: 'devnet',
      account: async () => null,
      lifetime: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1n }) as never,
    } as never);
    state.app = app;
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false }).split('\n').length;
    expect(routes).toBeGreaterThan(100);
    const res = await app.inject({ method: 'GET', url: '/v1/treasuries' });
    expect(res.statusCode).toBe(200);
  }, 120_000);
});
