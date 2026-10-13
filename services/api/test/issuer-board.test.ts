// The issuer board over HTTP against a real Postgres (PGlite) carrying the indexer's own tables: the signing protocol, the rules of
// each record kind, the demand map and its arithmetic, curator decisions, and the questions and answers with their overdue clock.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { type KeyPairSigner, generateKeyPairSigner, signBytes } from '@solana/kit';
import { RequestError } from '../src/tx.js';
import { HOURLY_LIMIT, QA_OVERDUE_SECS, registerIssuerBoard } from '../src/routes/issuer-board.js';
import { RECORD_SCHEMA, parseDecimal, recordId, signingMessage, verifyRecord } from '../src/routes/issuer-signed.js';
import { addCross, addOrder, holderDb } from './helpers/holder-pg.js';

let NOW = 1_800_000_000;
const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../../indexer/migrations/${name}`, import.meta.url)), 'utf8');

describe('issuer board', () => {
  let db: PGlite;
  let app: ReturnType<typeof Fastify>;
  let issuer: KeyPairSigner, curator: KeyPairSigner, alice: KeyPairSigner, bob: KeyPairSigner, carol: KeyPairSigner, stranger: KeyPairSigner;
  let crossAddr: string;
  let treasuryAddr: string;
  let authority: KeyPairSigner;

  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as never }) });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  /** The whole client path: prepare, sign the message in a wallet, submit. */
  const publish = async (signer: KeyPairSigner, kind: string, body: unknown) => {
    const prep = await call('POST', '/v1/issuer/records/prepare', { kind, signer: signer.address, body });
    if (prep.status !== 200) return prep;
    const signature = Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(prep.body.message))).toString('hex');
    return call('POST', '/v1/issuer/records', { record: prep.body.record, signature });
  };

  const draftBody = (over: Record<string, unknown> = {}) => ({ title: 'Northwind Coffee', summary: 'Roasting and selling coffee.', baseMint: null, quoteMint: null, baseDecimals: 6, quoteDecimals: 6, minPrice: '1.00', tick: '0.10', ticks: 10, offered: '1000', supplyMode: 'mint', ...over });
  const appBody = (over: Record<string, unknown> = {}) => ({ name: 'Northwind', description: 'A coffee company.', website: 'https://northwind.example/', team: 'Two founders.', cohort: null, listingType: 'ownership-coin', draft: null, baseMint: null, contact: null, selfChecks: [{ id: 'authority', status: 'pass' }], acknowledged: true, ...over });

  beforeAll(async () => {
    [issuer, curator, alice, bob, carol, stranger, authority] = await Promise.all(Array.from({ length: 7 }, () => generateKeyPairSigner()));
    db = await holderDb();
    await db.exec(sql('006_treasury.sql'));
    crossAddr = (await generateKeyPairSigner()).address;
    await db.query(`INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
                    VALUES ($1, $2, 0, 1, 1, 'B', 'Q', 1, 2, 2, 0, 0, 'Live', 1, 1)`, [crossAddr, issuer.address]);
    treasuryAddr = (await generateKeyPairSigner()).address;
    await db.query(`INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, updated_slot, state) VALUES ($1, 'C', $2, 1, 60, 's', 1, 1, 'Active')`, [treasuryAddr, authority.address]);
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).type('application/json').send({ error: e.message });
    });
    registerIssuerBoard(app, { db: db as never, curators: new Set([curator.address]), clock: () => NOW });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  describe('signing protocol', () => {
    it('stores a record only with the signer’s own signature over its id', async () => {
      const r = await publish(issuer, 'draft', draftBody());
      expect(r.status).toBe(201);
      expect(r.body.record).toMatchObject({ kind: 'draft', signer: issuer.address, issuedAt: NOW });
      const again = await publish(issuer, 'draft', draftBody()); // same body, same second: same id
      expect(again.status).toBe(200);
      expect(again.body.duplicate).toBe(true);
    });

    it('refuses a signature by another wallet, a tampered record, a bad signature and a stale one', async () => {
      const prep = await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: issuer.address, body: draftBody({ title: 'Other' }) });
      const sign = async (who: KeyPairSigner, msg = prep.body.message) => Buffer.from(await signBytes(who.keyPair.privateKey, new TextEncoder().encode(msg))).toString('hex');
      const wrongWallet = await call('POST', '/v1/issuer/records', { record: prep.body.record, signature: await sign(stranger) });
      expect(wrongWallet).toMatchObject({ status: 400, body: { error: expect.stringContaining('BAD_SIGNATURE') } });
      const tampered = await call('POST', '/v1/issuer/records', { record: { ...prep.body.record, body: { ...prep.body.record.body, title: 'Changed' } }, signature: await sign(issuer) });
      expect(tampered.status).toBe(400);
      const other = await call('POST', '/v1/issuer/records', { record: prep.body.record, signature: await sign(issuer, `${prep.body.message}x`) });
      expect(other.status).toBe(400);
      expect((await call('POST', '/v1/issuer/records', { record: prep.body.record, signature: 'zz' })).status).toBe(400);
      NOW += 700;
      const stale = await call('POST', '/v1/issuer/records', { record: prep.body.record, signature: await sign(issuer) });
      NOW -= 700;
      expect(stale).toMatchObject({ status: 400, body: { error: expect.stringMatching(/more than 600 s/) } });
    });

    it('verifyRecord and the id are deterministic and bound to every field', async () => {
      const rec = { schema: RECORD_SCHEMA, kind: 'draft' as const, signer: issuer.address, issuedAt: NOW, body: { a: 1 } };
      const id = recordId(rec);
      const sig = Buffer.from(await signBytes(issuer.keyPair.privateKey, new TextEncoder().encode(signingMessage(id)))).toString('hex');
      expect(await verifyRecord(rec, sig, id)).toEqual({ ok: true });
      expect(await verifyRecord({ ...rec, issuedAt: NOW + 1 }, sig, id)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
      expect(await verifyRecord({ ...rec, signer: alice.address }, sig, recordId({ ...rec, signer: alice.address }))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
      expect(recordId({ ...rec, body: { b: 1, a: 1 } as never })).toBe(recordId({ ...rec, body: { a: 1, b: 1 } as never })); // key order does not matter
    });

    it('rejects unknown kinds, unknown fields, junk bodies and missing parts', async () => {
      expect((await call('POST', '/v1/issuer/records/prepare', { kind: 'vote', signer: issuer.address, body: {} })).status).toBe(400);
      expect((await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: 'x', body: draftBody() })).status).toBe(400);
      const extra = await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: issuer.address, body: draftBody({ admin: true }) });
      expect(extra).toMatchObject({ status: 400, body: { error: expect.stringContaining('admin is not a field') } });
      expect((await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: issuer.address, body: [] })).status).toBe(400);
      expect((await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: issuer.address })).status).toBe(400);
      expect((await call('POST', '/v1/issuer/records/prepare', null as never)).status).toBe(400);
      expect((await call('POST', '/v1/issuer/records', {})).status).toBe(400);
      expect((await call('POST', '/v1/issuer/records', { record: { schema: 'nope' }, signature: 'a' })).status).toBe(400);
    });

    it('limits one wallet to thirty records an hour', async () => {
      const spammer = await generateKeyPairSigner();
      for (let i = 0; i < HOURLY_LIMIT; i++) expect((await publish(spammer, 'draft', draftBody({ title: `d${i}` }))).status).toBe(201);
      const over = await publish(spammer, 'draft', draftBody({ title: 'one more' }));
      expect(over.status).toBe(429);
      NOW += 3601;
      expect((await publish(spammer, 'draft', draftBody({ title: 'later' }))).status).toBe(201);
      NOW -= 3601;
    });
  });

  describe('drafts', () => {
    it('validates every field and names the ones that fail', async () => {
      const bad = await call('POST', '/v1/issuer/records/prepare', { kind: 'draft', signer: issuer.address, body: draftBody({ title: '', ticks: 1, quoteDecimals: 30, minPrice: 'abc', supplyMode: 'airdrop', baseMint: 'nope' }) });
      expect(bad.status).toBe(400);
      for (const f of ['title', 'ticks', 'quoteDecimals', 'minPrice', 'supplyMode', 'baseMint']) expect(bad.body.fields.some((m: string) => m.startsWith(`${f} `)), f).toBe(true);
    });
    it('serves a draft as not verified, with an empty demand map before any commit', async () => {
      const d = await publish(issuer, 'draft', draftBody({ title: 'Empty one' }));
      const got = await call('GET', `/v1/issuer/drafts/${d.body.record.id}`);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ status: 'not-verified', commits: { wallets: 0 }, levels: [], notCollected: ['region', 'identity'] });
      expect((await call('GET', '/v1/issuer/drafts/zz')).status).toBe(400);
      expect((await call('GET', `/v1/issuer/drafts/${'0'.repeat(64)}`)).status).toBe(404);
    });
  });

  describe('soft commits and the demand map', () => {
    let draftId: string;
    beforeAll(async () => {
      draftId = (await publish(issuer, 'draft', draftBody({ title: 'Demand draft' }))).body.record.id;
      // alice: bid and was filled before. bob: bid before, not filled. carol: no history.
      await addCross(db, { address: 'PastCross1', state: 'Finalized', open: 1, close: 2 });
      await addCross(db, { address: 'PastCross2', state: 'Finalized', open: 1, close: 2 });
      await addOrder(db, { cross: 'PastCross1', idx: 0, address: 'o1', owner: alice.address, status: 'claimed', fill: '5' });
      await addOrder(db, { cross: 'PastCross2', idx: 0, address: 'o2', owner: alice.address, status: 'claimed', fill: '0' });
      await addOrder(db, { cross: 'PastCross1', idx: 1, address: 'o3', owner: bob.address, status: 'claimed', fill: '0' });
    });

    it('refuses a commit to a draft that does not exist, off the grid, zero, too precise, or too small to buy an atom', async () => {
      const c = (over: Record<string, unknown>) => call('POST', '/v1/issuer/records/prepare', { kind: 'softcommit', signer: alice.address, body: { draft: draftId, price: '1.20', amount: '100', note: null, ...over } });
      expect((await c({ draft: '1'.repeat(64) })).status).toBe(404);
      expect(await c({ price: '1.25' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not on the draft’s price grid/) } });
      expect(await c({ price: '0.90' })).toMatchObject({ status: 400 }); // below the lowest price
      expect(await c({ price: '2.10' })).toMatchObject({ status: 400 }); // above the top (1.0 + 9*0.1 = 1.9)
      expect(await c({ amount: '0' })).toMatchObject({ status: 400 });
      expect(await c({ amount: '1.0000001' })).toMatchObject({ status: 400 });
      expect((await c({ amount: 'lots' })).status).toBe(400);
      expect(await c({ price: '1.20', amount: '0.000001' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/too small/) } });
    });

    it('computes demand by price level exactly, and groups wallets by their track record', async () => {
      // alice: 120 quote at limit 1.20 -> 100 tokens. bob: 150 at 1.50 -> 100 tokens. carol: 90 at 1.50 -> 60 tokens.
      expect((await publish(alice, 'softcommit', { draft: draftId, price: '1.20', amount: '120', note: 'in' })).status).toBe(201);
      expect((await publish(bob, 'softcommit', { draft: draftId, price: '1.50', amount: '150', note: null })).status).toBe(201);
      expect((await publish(carol, 'softcommit', { draft: draftId, price: '1.50', amount: '90', note: null })).status).toBe(201);
      const m = await call('GET', `/v1/issuer/drafts/${draftId}`);
      expect(m.body.commits).toEqual({ wallets: 3, totalBudget: '360000000', totalTokens: '260000000' });
      expect(m.body.levels).toEqual([
        { index: 2, price: '1200000', tokens: '100000000', budget: '120000000', wallets: 1 },
        { index: 5, price: '1500000', tokens: '160000000', budget: '240000000', wallets: 2 },
      ]);
      expect(m.body.byTrackRecord).toEqual({ 'filled-before': { wallets: 1, tokens: '100000000' }, 'bid-before': { wallets: 1, tokens: '100000000' }, 'no-history': { wallets: 1, tokens: '60000000' } });
      expect(m.body.grid).toMatchObject({ minPrice: '1000000', tick: '100000', ticks: 10, quoteDecimals: 6, baseDecimals: 6 });
    });

    it('a wallet’s later commit replaces its earlier one, so interest is never counted twice', async () => {
      NOW += 5;
      expect((await publish(alice, 'softcommit', { draft: draftId, price: '1.30', amount: '130', note: null })).status).toBe(201);
      const m = await call('GET', `/v1/issuer/drafts/${draftId}`);
      expect(m.body.commits.wallets).toBe(3);
      expect(m.body.levels.map((l: { index: number }) => l.index)).toEqual([3, 5]);
      NOW -= 5;
    });

    it('lists records by kind, subject and signer', async () => {
      const list = await call('GET', `/v1/issuer/records?kind=softcommit&subject=${draftId}`);
      expect(list.body.records).toHaveLength(3);
      expect((await call('GET', `/v1/issuer/records?kind=softcommit&signer=${alice.address}`)).body.records.length).toBe(1);
      expect((await call('GET', '/v1/issuer/records?kind=nope')).status).toBe(400);
      expect((await call('GET', '/v1/issuer/records?limit=0')).status).toBe(400);
      expect((await call('GET', '/v1/issuer/records?signer=x')).status).toBe(400);
    });
  });

  describe('applications and curation', () => {
    it('refuses an application that does not acknowledge it is public, names a listing type that does not exist, or points at a missing draft', async () => {
      const p = (over: Record<string, unknown>) => call('POST', '/v1/issuer/records/prepare', { kind: 'application', signer: issuer.address, body: appBody(over) });
      expect(await p({ acknowledged: false })).toMatchObject({ status: 400, body: { error: expect.stringContaining('acknowledged') } });
      expect((await p({ listingType: 'moonshot' })).status).toBe(400);
      expect((await p({ website: 'javascript:alert(1)' })).status).toBe(400);
      expect((await p({ draft: '2'.repeat(64) })).status).toBe(404);
      expect((await p({ selfChecks: Array.from({ length: 21 }, () => ({ id: 'a', status: 'pass' })) })).status).toBe(400);
      expect((await p({ selfChecks: [{ id: 'a', status: 'great' }] })).status).toBe(400);
    });

    it('stores an application, shows it as submitted, and shows a curator’s decision once one is made', async () => {
      const a = await publish(issuer, 'application', appBody());
      expect(a.status).toBe(201);
      const id = a.body.record.id;
      expect(await call('GET', `/v1/issuer/applications/${id}`)).toMatchObject({ status: 200, body: { status: 'submitted', decision: null, curatorsConfigured: 1 } });
      NOW += 10;
      const d1 = await publish(curator, 'decision', { application: id, outcome: 'changes-requested', note: 'Name the attester.' });
      expect(d1.status).toBe(201);
      expect((await call('GET', `/v1/issuer/applications/${id}`)).body).toMatchObject({ status: 'changes-requested', decision: { body: { note: 'Name the attester.' } } });
      NOW += 10;
      await publish(curator, 'decision', { application: id, outcome: 'accepted', note: null });
      expect((await call('GET', `/v1/issuer/applications/${id}`)).body.status).toBe('accepted'); // the latest decision wins
      NOW -= 20;
    });

    it('keeps the cohort an applicant names and filters nothing on it: it is a claim, not a membership', async () => {
      const a = await publish(issuer, 'application', appBody({ name: 'Cohort Co', cohort: 'Example accelerator, spring cohort' }));
      expect(a.status).toBe(201);
      expect(a.body.record.body.cohort).toBe('Example accelerator, spring cohort');
      expect((await publish(issuer, 'application', appBody({ name: 'Too long', cohort: 'x'.repeat(81) }))).status).toBe(400);
    });

    it('only a configured curator can decide, and a decision needs a real application', async () => {
      const id = (await publish(issuer, 'application', appBody({ name: 'Second' }))).body.record.id;
      expect(await publish(issuer, 'decision', { application: id, outcome: 'accepted', note: null })).toMatchObject({ status: 422, body: { reason: 'NOT_A_CURATOR' } });
      expect(await publish(curator, 'decision', { application: '3'.repeat(64), outcome: 'declined', note: null })).toMatchObject({ status: 404 });
      expect((await publish(curator, 'decision', { application: id, outcome: 'maybe', note: null })).status).toBe(400);
      expect((await call('GET', '/v1/issuer/curators')).body).toMatchObject({ configured: 1, curators: [curator.address] });
      expect((await call('GET', `/v1/issuer/applications/${'4'.repeat(64)}`)).status).toBe(404);
      expect((await call('GET', '/v1/issuer/applications/zz')).status).toBe(400);
    });

    it('with no curators configured, nobody can decide and the service says so', async () => {
      const bare = Fastify({ logger: false });
      bare.setErrorHandler((err, _req, reply) => reply.code((err as RequestError).status ?? 500).type('application/json').send({ error: (err as Error).message, ...(err as RequestError).detail }));
      registerIssuerBoard(bare, { db: db as never, clock: () => NOW });
      await bare.ready();
      const r = await bare.inject({ method: 'GET', url: '/v1/issuer/curators' });
      expect(JSON.parse(r.body)).toMatchObject({ configured: 0, curators: [] });
      const prep = await bare.inject({ method: 'POST', url: '/v1/issuer/records/prepare', payload: { kind: 'decision', signer: curator.address, body: { application: (await db.query<{ id: string }>("SELECT id FROM issuer_records WHERE kind = 'application' LIMIT 1")).rows[0]!.id, outcome: 'accepted', note: null } } });
      expect(prep.statusCode).toBe(422);
      expect(JSON.parse(prep.body).error).toMatch(/No curators are configured/);
      await bare.close();
    });
  });

  describe('questions and answers', () => {
    it('lists nothing for a subject that is not indexed and refuses questions about one', async () => {
      expect((await call('GET', `/v1/issuer/qa?subject=${stranger.address}`)).status).toBe(404);
      expect((await call('GET', '/v1/issuer/qa')).status).toBe(400);
      expect(await publish(alice, 'question', { subject: stranger.address, subjectKind: 'cross', text: 'Hello?' })).toMatchObject({ status: 404 });
    });

    it('a question on a cross is requested, then overdue after a week, and answered only by the cross’s creator', async () => {
      const q = await publish(alice, 'question', { subject: crossAddr, subjectKind: 'cross', text: 'Is the team locked up?' });
      expect(q.status).toBe(201);
      const qa = async () => (await call('GET', `/v1/issuer/qa?subject=${crossAddr}`)).body;
      expect((await qa()).questions[0]).toMatchObject({ state: 'requested', answer: null });
      expect((await qa())).toMatchObject({ subjectKind: 'cross', owner: issuer.address, overdueAfterSecs: QA_OVERDUE_SECS });
      NOW += QA_OVERDUE_SECS + 1;
      expect((await qa()).questions[0].state).toBe('overdue');
      expect(await publish(stranger, 'answer', { question: q.body.record.id, text: 'I am not the creator.' })).toMatchObject({ status: 422, body: { reason: 'NOT_THE_OWNER', owner: issuer.address } });
      expect((await qa()).questions[0].state).toBe('overdue');
      const a = await publish(issuer, 'answer', { question: q.body.record.id, text: 'Yes, twelve months.' });
      expect(a.status).toBe(201);
      expect((await qa()).questions[0]).toMatchObject({ state: 'answered', answer: { signer: issuer.address, body: { text: 'Yes, twelve months.' } } });
      NOW -= QA_OVERDUE_SECS + 1;
    });

    it('a treasury’s questions are answered by its authority', async () => {
      const q = await publish(bob, 'question', { subject: treasuryAddr, subjectKind: 'treasury', text: 'When is the next update?' });
      expect(q.status).toBe(201);
      expect(await publish(issuer, 'answer', { question: q.body.record.id, text: 'Soon.' })).toMatchObject({ status: 422, body: { reason: 'NOT_THE_OWNER' } });
      expect((await publish(authority, 'answer', { question: q.body.record.id, text: 'Friday.' })).status).toBe(201);
      expect((await call('GET', `/v1/issuer/qa?subject=${treasuryAddr}`)).body).toMatchObject({ subjectKind: 'treasury', owner: authority.address });
    });

    it('rejects a question with the wrong subject kind, an empty text, and an answer to nothing', async () => {
      expect(await publish(alice, 'question', { subject: treasuryAddr, subjectKind: 'cross', text: 'x' })).toMatchObject({ status: 404 });
      expect((await publish(alice, 'question', { subject: crossAddr, subjectKind: 'cross', text: '   ' })).status).toBe(400);
      expect((await publish(issuer, 'answer', { question: '5'.repeat(64), text: 'x' })).status).toBe(404);
    });
  });
});

describe('parseDecimal', () => {
  it('parses exactly and refuses what would round', () => {
    expect(parseDecimal('1.5', 6)).toBe(1_500_000n);
    expect(parseDecimal('0.000001', 6)).toBe(1n);
    expect(parseDecimal('0.0000001', 6)).toBeNull();
    expect(parseDecimal('1.', 6)).toBeNull();
    expect(parseDecimal('-1', 6)).toBeNull();
    expect(parseDecimal('1e3', 6)).toBeNull();
    expect(parseDecimal(5 as never, 6)).toBeNull();
    expect(parseDecimal('12', 0)).toBe(12n);
    expect(parseDecimal('12.5', 0)).toBeNull();
  });
});
