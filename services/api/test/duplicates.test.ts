// GET /v1/tokens/:mint/duplicates: a token compared with the tokens already listed and with the issuers' own lists. The token
// labels are stood in for (the metadata decoding has its own tests in packages/authenticity); the database and the route are real.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLED_REGISTRY } from '@opening-cross/authenticity';
import { registerTokenDuplicates } from '../src/routes/duplicates.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, newAddress, openSchema } from './helpers/w2a.js';

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('duplicates.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('token duplicates route', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  const labels = new Map<string, { exists: boolean; isMint: boolean; name: string | null; symbol: string | null }>();
  const reads: string[] = [];
  const chain = new Chain();

  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const token = async (symbol: string | null, name: string | null, listed = true) => {
    const mint = await newAddress();
    labels.set(mint, { exists: true, isMint: true, name, symbol });
    if (listed) {
      const cross = await newAddress();
      await insertCross(db, cross, { slot: 1 });
      await db.query('UPDATE crosses SET base_mint = $2 WHERE address = $1', [cross, mint]);
    }
    return mint;
  };

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : reply.code(500).send({ error: String(err) })));
    registerTokenDuplicates(app, { db, account: chain.read }, {
      observe: async (m) => {
        reads.push(m);
        return labels.get(m) ?? { exists: false, isMint: false, name: null, symbol: null };
      },
      maxFreshReads: 3,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it('warns about a listed token with the same or a look-alike ticker, and about the issuers\' own tickers', async () => {
    const original = await token('MOON', 'Moon Coin');
    const copy = await token('MООN', 'Moon Coin 2', false); // Cyrillic О
    const r = await get(`/v1/tokens/${copy}/duplicates`);
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ verdict: 'warn', worst: 'high', count: 1 });
    expect(r.body.duplicates[0]).toMatchObject({ mint: original, source: 'listed on a cross', relation: 'look-alike-symbol', severity: 'high' });
    expect(r.body.limits.join(' ')).toContain('Images are not');

    const real = BUNDLED_REGISTRY.mints[0]!;
    const impostor = await token(real.symbol, 'Totally Different', false);
    const i = await get(`/v1/tokens/${impostor}/duplicates`);
    expect(i.body.duplicates.some((x: { mint: string; relation: string; source: string }) => x.mint === real.mint && x.relation === 'same-symbol' && x.source.startsWith('issuer list'))).toBe(true);
  });

  it('is clear when nothing collides, unknown when the token declares nothing', async () => {
    const lone = await token('QZXW', 'Quartz Extra Wide', false);
    const clear = await get(`/v1/tokens/${lone}/duplicates`);
    expect(clear.body.summary).toEqual({ verdict: 'clear', worst: null, count: 0 });
    const nameless = await token(null, null, false);
    expect((await get(`/v1/tokens/${nameless}/duplicates`)).body.summary.verdict).toBe('unknown');
  });

  it('reads each listed token\'s metadata once, and says how many it has not reached yet', async () => {
    const before = new Set(reads);
    for (let i = 0; i < 5; i++) await token(`FILL${i}`, `Filler ${i}`);
    const probe = await token('PROBE', 'Probe', false);
    const first = await get(`/v1/tokens/${probe}/duplicates`);
    // maxFreshReads is 3: no more than three new listed tokens are read in one request, and the rest are counted.
    expect(first.body.comparedWith.listedNotYetChecked).toBeGreaterThan(0);
    expect(first.body.limits.join(' ')).toMatch(/have not been read yet/);
    const readsAfterFirst = reads.length;
    for (let i = 0; i < 6; i++) await get(`/v1/tokens/${probe}/duplicates`);
    // Every listed token ends up cached; later requests read only the candidate.
    const final = await get(`/v1/tokens/${probe}/duplicates`);
    expect(final.body.comparedWith.listedNotYetChecked).toBe(0);
    const listedReads = [...reads].filter((m) => !before.has(m) && m !== probe);
    expect(new Set(listedReads).size).toBe(listedReads.length); // none read twice
    expect(reads.length).toBeGreaterThan(readsAfterFirst);
  });

  it('refuses a bad address, an absent mint and something that is not a mint', async () => {
    expect((await get('/v1/tokens/not-an-address/duplicates')).status).toBe(400);
    expect((await get(`/v1/tokens/${await newAddress()}/duplicates`)).status).toBe(404);
    const notMint = await newAddress();
    labels.set(notMint, { exists: true, isMint: false, name: null, symbol: null });
    expect((await get(`/v1/tokens/${notMint}/duplicates`)).status).toBe(422);
  });
});
