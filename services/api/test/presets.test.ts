// The preset registry routes over a real database: publishing, versions, attribution by memo (read from the creation transaction), and
// performance that counts only crosses that carried the memo.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { signDocument } from '@opening-cross/attest';
import { PRESET_SCHEMA, type PresetBody, presetMemo } from '@opening-cross/preset-registry';
import { registerPresets } from '../src/routes/presets.js';
import { RequestError } from '../src/tx.js';
import { databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('presets.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('preset registry routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let kp: CryptoKeyPair;
  let author = '';
  const memos = new Map<string, string[] | null>();
  const reads: string[] = [];

  const fields = { kind: 'reopen', disclosure: 'open', supplyMode: 'escrow', ticks: 40, stepBps: 100, openInMinutes: 5, callMinutes: 60, revealMinutes: 0, maxOrders: 500 } as const;
  const body = (over: Partial<PresetBody> = {}): PresetBody => ({ schema: PRESET_SCHEMA, id: 'open-reopen', version: 1, author, name: 'Open reopen, one hour', summary: 'An open one hour reopen with forty price levels.', fields, royaltyBps: 50, tags: ['reopen'], createdAt: 1_800_000_000, ...over });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
    return { status: r.statusCode, body: r.json() };
  };
  /** A finalized cross with `n` bidding wallets whose creation signature is `sig`. */
  async function cross(sig: string, n: number, printed: boolean): Promise<string> {
    const a = await newAddress();
    await insertCross(db, a, { state: printed ? 'Finalized' : 'NoPrint' });
    await db.query("INSERT INTO events (signature, seq, slot, name, cross_address, payload) VALUES ($1, 0, 1, 'CrossCreated', $2, '{}')", [sig, a]);
    if (printed) await db.query('UPDATE crosses SET clearing_price = 1500000, matched = 80 WHERE address = $1', [a]);
    for (let i = 0; i < n; i++) {
      await insertOrder(db, a, i * 2, await newAddress(), 'buy', 1_500_000n, 100n);
      await insertOrder(db, a, i * 2 + 1, await newAddress(), 'sell', 1_400_000n, 20n);
    }
    return a;
  }

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    kp = await generateKeyPair();
    author = await getAddressFromPublicKey(kp.publicKey);
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : reply.code(500).send({ error: String(err) })));
    registerPresets(app, { db, network: 'test' }, { memosOf: async (s) => (reads.push(s), memos.get(s) ?? null), minimumSample: 3 });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  it('publishes a signed preset and refuses an unsigned, forged, invalid or stale one', async () => {
    const ok = await call('POST', '/v1/presets', await signDocument(body(), kp));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ stored: true, id: 'open-reopen', version: 1, memo: presetMemo(author, 'open-reopen', 1) });
    expect(ok.body.royaltyNote).toMatch(/declared claim/);
    expect((await call('POST', '/v1/presets', null)).status).toBe(400);
    const other = await generateKeyPair();
    expect((await call('POST', '/v1/presets', await signDocument(body({ id: 'by-someone-else' }), other))).status).toBe(400); // signed by a key that is not the author
    expect((await call('POST', '/v1/presets', await signDocument(body({ id: 'bad-ticks', fields: { ...fields, ticks: 999 } }), kp))).body.error).toMatch(/fields.ticks/);
    const same = await call('POST', '/v1/presets', await signDocument(body({ summary: 'A changed summary, same version number.' }), kp));
    expect(same.status).toBe(409);
    expect(same.body.error).toMatch(/never changed/);
    expect((await call('POST', '/v1/presets', await signDocument(body({ version: 2, name: 'Open reopen, one hour (v2)' }), kp))).status).toBe(201);
  });

  it('lists the newest version of each preset and every version of one', async () => {
    const list = await call('GET', '/v1/presets');
    const mine = list.body.presets.find((p: { id: string }) => p.id === 'open-reopen');
    expect(mine).toMatchObject({ version: 2, kind: 'reopen', author });
    expect(list.body.notice).toMatch(/Not a ranking/);
    expect((await call('GET', '/v1/presets?kind=launch')).body.presets.find((p: { id: string }) => p.id === 'open-reopen')).toBeUndefined();
    expect((await call('GET', '/v1/presets?tag=reopen')).body.presets.length).toBeGreaterThan(0);
    const versions = await call('GET', `/v1/presets/${author}/open-reopen`);
    expect(versions.body.versions.map((v: { body: { version: number } }) => v.body.version)).toEqual([2, 1]);
    expect((await call('GET', `/v1/presets/${author}/nope-nope`)).status).toBe(404);
    expect((await call('GET', '/v1/presets/not-an-address/x')).status).toBe(400);
  });

  it('says how to use a version: the fields it sets and the memo that attributes the cross', async () => {
    const use = await call('GET', `/v1/presets/${author}/open-reopen/1/use`);
    expect(use.status).toBe(200);
    expect(use.body.memo).toBe(`oc-preset:1:${author}/open-reopen@1`);
    expect(use.body.fields).toMatchObject({ kind: 'reopen', ticks: 40 });
    expect(use.body.howToUse).toMatch(/sets no price, supply or raise/);
    expect((await call('GET', `/v1/presets/${author}/open-reopen/9/use`)).status).toBe(404);
    expect((await call('GET', `/v1/presets/${author}/open-reopen/x/use`)).status).toBe(400);
  });

  it('counts only crosses whose creation transaction carries the memo, and reads each transaction once', async () => {
    const a = await cross('sigA', 3, true);
    const b = await cross('sigB', 4, true);
    const c = await cross('sigC', 2, false);
    const d = await cross('sigD', 5, true); // same values, no memo: not counted
    const e = await cross('sigE', 3, true); // another preset's memo
    memos.set('sigA', [presetMemo(author, 'open-reopen', 1)]);
    memos.set('sigB', ['unrelated memo', presetMemo(author, 'open-reopen', 2)]);
    memos.set('sigC', [presetMemo(author, 'open-reopen', 2)]);
    memos.set('sigD', []);
    memos.set('sigE', [presetMemo(author, 'some-other', 1)]);
    void [a, b, c, d, e];
    const all = await call('GET', `/v1/presets/${author}/open-reopen/performance`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ crosses: 3, finished: 3, printed: 2, headline: true, minimumSample: 3 });
    expect(all.body.printRate.value).toBeCloseTo(2 / 3, 10);
    expect(all.body.medianWallets).toBe(6); // wallets 6, 8 and 4 -> sorted 4, 6, 8
    const v2 = await call('GET', `/v1/presets/${author}/open-reopen/performance?version=2`);
    expect(v2.body).toMatchObject({ crosses: 2, headline: false });
    expect(v2.body.caveats.join(' ')).toMatch(/Only 2 finished crosses/);
    const before = reads.length;
    await call('GET', `/v1/presets/${author}/open-reopen/performance`);
    expect(reads.length).toBe(before); // every creation transaction was read once
    expect(new Set(reads).size).toBe(reads.length);
    expect((await call('GET', `/v1/presets/${author}/open-reopen/performance?version=0`)).status).toBe(400);
  });

  it('tries again later when a creation transaction cannot be read, and does not count the cross meanwhile', async () => {
    const late = await cross('sigLate', 3, true);
    void late;
    const first = await call('GET', `/v1/presets/${author}/open-reopen/performance?version=1`);
    expect(first.body.attribution.remaining).toBeGreaterThanOrEqual(1);
    expect(first.body.crosses).toBe(1);
    memos.set('sigLate', [presetMemo(author, 'open-reopen', 1)]);
    const second = await call('GET', `/v1/presets/${author}/open-reopen/performance?version=1`);
    expect(second.body.crosses).toBe(2);
  });
});
