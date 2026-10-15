import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { verifyDocument } from '@opening-cross/attest';
import { migrate } from '@opening-cross/indexer';
import { GENESIS, allows, apiEvidence, authenticate, entryHash, hashToken, parseTokens, registerOps, secretMatches, verifyChain, type TokenEntry } from '../src/index.js';

const TOK = { viewer: 'viewer-token-aaaaaaaaaaaaaaaa', alice: 'alice-reviewer-token-bbbbbbbbbbbb', bob: 'bob-reviewer-token-cccccccccccccc', root: 'root-admin-token-dddddddddddddddd' };
const entries: TokenEntry[] = [
  { name: 'vera', role: 'viewer', sha256: hashToken(TOK.viewer) },
  { name: 'alice', role: 'reviewer', sha256: hashToken(TOK.alice) },
  { name: 'bob', role: 'reviewer', sha256: hashToken(TOK.bob) },
  { name: 'root', role: 'admin', sha256: hashToken(TOK.root) },
];
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CROSS = 'DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T';

describe('tokens', () => {
  it('parses a configuration and rejects a malformed one', () => {
    expect(parseTokens(undefined)).toEqual([]);
    expect(parseTokens(JSON.stringify(entries))).toHaveLength(4);
    expect(() => parseTokens('nope')).toThrow(/must be JSON/);
    expect(() => parseTokens('{}')).toThrow(/JSON list/);
    expect(() => parseTokens(JSON.stringify([{ name: 'a b', role: 'admin', sha256: hashToken('x') }]))).toThrow(/name/);
    expect(() => parseTokens(JSON.stringify([{ name: 'a', role: 'root', sha256: hashToken('x') }]))).toThrow(/role/);
    expect(() => parseTokens(JSON.stringify([{ name: 'a', role: 'admin', sha256: 'ABC' }]))).toThrow(/sha256/);
    expect(() => parseTokens(JSON.stringify([entries[0], entries[0]]))).toThrow(/twice/);
  });
  it('authenticates a bearer token against hashes, and ranks roles', () => {
    expect(authenticate(`Bearer ${TOK.alice}`, entries)).toEqual({ name: 'alice', role: 'reviewer' });
    expect(authenticate(`Bearer ${TOK.alice}x`, entries)).toBeNull();
    expect(authenticate(TOK.alice, entries)).toBeNull();
    expect(authenticate('Bearer short', entries)).toBeNull();
    expect(authenticate(undefined, entries)).toBeNull();
    expect(allows('admin', 'reviewer')).toBe(true);
    expect(allows('viewer', 'reviewer')).toBe(false);
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abc', 'abd')).toBe(false);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('ops.test.ts: console tests SKIPPED; set DATABASE_URL to a Postgres to run them');

describeDb('operations console', () => {
  let db: pg.Pool;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let bare: FastifyInstance;
  let signerAddress = '';
  let t = 1_800_000_000;
  const gathered: { mint?: string; cross?: string }[] = [];
  let failSource = false;

  beforeAll(async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrate(db);
    drop = async () => {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
    const kp = await generateKeyPair();
    signerAddress = await getAddressFromPublicKey(kp.publicKey);
    app = Fastify();
    registerOps(app, { db }, {
      tokens: entries,
      signer: { keyPair: kp, address: signerAddress },
      webhookSecret: 'hook-secret-123',
      clock: () => ++t,
      evidence: async (s) => {
        gathered.push(s);
        return { safety: { ok: true, data: { verdict: 'disclosures' } }, holders: failSource ? { ok: false, error: 'HTTP 503' } : { ok: true, data: { coveredBps: 10000 } } };
      },
    });
    bare = Fastify();
    registerOps(bare, { db }, { tokens: [] });
    await app.ready();
    await bare.ready();
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
    await drop();
  });

  const call = async (method: 'GET' | 'POST', url: string, who: keyof typeof TOK | null, payload?: unknown, a = app) => {
    const r = await a.inject({ method, url, ...(who ? { headers: { authorization: `Bearer ${TOK[who]}` } } : {}), ...(payload === undefined ? {} : { payload: payload as never }) });
    return { status: r.statusCode, body: r.json() };
  };

  it('refuses everything without a token, and everything when no tokens are configured', async () => {
    expect((await call('GET', '/v1/ops/me', null)).status).toBe(401);
    expect((await a(`Bearer ${'z'.repeat(30)}`)).status).toBe(401);
    expect((await call('GET', '/v1/ops/me', 'viewer')).body).toEqual({ name: 'vera', role: 'viewer' });
    const none = await call('GET', '/v1/ops/me', 'viewer', undefined, bare);
    expect(none.status).toBe(503);
    expect(none.body.error).toMatch(/refuses every request/);
    async function a(h: string) {
      const r = await app.inject({ method: 'GET', url: '/v1/ops/me', headers: { authorization: h } });
      return { status: r.statusCode };
    }
  });

  it('keeps each role to what it may do', async () => {
    expect((await call('POST', '/v1/ops/cases', 'viewer', { kind: 'fraud', subject: 'wallet-1', summary: 'a viewer cannot open this' })).status).toBe(403);
    expect((await call('POST', '/v1/ops/incidents/x/resolve', 'alice', { resolution: 'a reviewer cannot resolve' })).status).toBe(403);
    expect((await call('GET', '/v1/ops/log/verify', 'alice')).status).toBe(403);
    expect((await call('GET', '/v1/ops/log/verify', 'root')).status).toBe(200);
  });

  it('opens a listing review with gathered evidence, and a second person decides it', async () => {
    const open = await call('POST', '/v1/ops/listings', 'alice', { mint: MINT, note: 'Issuer asked to list the new stock token' });
    expect(open.status).toBe(201);
    expect(gathered.at(-1)).toEqual({ mint: MINT });
    expect(open.body.evidence.safety.ok).toBe(true);
    const id = open.body.id;
    const self = await call('POST', `/v1/ops/listings/${id}/decision`, 'alice', { decision: 'approve', reason: 'I opened it, so I cannot decide it' });
    expect(self.status).toBe(403);
    expect((await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'approve', reason: 'too short' })).status).toBe(400);
    expect((await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'maybe', reason: 'a valid length reason here' })).status).toBe(400);
    const done = await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'approve', reason: 'Checked safety, holders and authenticity; no blocking property.' });
    expect(done.body).toEqual({ id, status: 'approved' });
    expect((await call('POST', `/v1/ops/listings/${id}/decision`, 'root', { decision: 'reject', reason: 'changing a decision needs a new review' })).status).toBe(409);
    const list = await call('GET', '/v1/ops/listings?status=approved', 'viewer');
    expect(list.body.listings.map((l: { id: string; decided_by: string }) => [l.id, l.decided_by])).toContainEqual([id, 'bob']);
  });

  it('will not approve on evidence that could not be gathered unless the reviewer says so, on the record', async () => {
    failSource = true;
    const open = await call('POST', '/v1/ops/listings', 'alice', { mint: MINT, cross: CROSS, note: 'Evidence source is down' });
    failSource = false;
    expect(open.body.evidence.holders.ok).toBe(false);
    const id = open.body.id;
    const blocked = await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'approve', reason: 'approving without the holder data' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/holders/);
    expect((await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'needs-info', reason: 'ask the issuer for the holder list' })).status).toBe(200);
    const ok = await call('POST', `/v1/ops/listings/${id}/decision`, 'bob', { decision: 'approve', reason: 'approving without the holder data, knowingly', acknowledgeMissingEvidence: true });
    expect(ok.status).toBe(200);
    const log = (await call('GET', '/v1/ops/log?limit=500', 'viewer')).body.entries.filter((e: { subject: string }) => e.subject === id);
    expect(log.at(-1).detail.missingEvidenceAcknowledged).toEqual(['holders']);
  });

  it('lets the second reviewer read the evidence the first one gathered, and shows which sources failed in the queue', async () => {
    failSource = true;
    const open = await call('POST', '/v1/ops/listings', 'alice', { mint: MINT, note: 'Holder source was down when this was opened' });
    failSource = false;
    const id = open.body.id;
    const one = await call('GET', `/v1/ops/listings/${id}`, 'bob');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id, mint: MINT, requested_by: 'alice', status: 'pending', decided_by: null });
    expect(one.body.evidence.safety).toEqual({ ok: true, data: { verdict: 'disclosures' } });
    expect(one.body.evidence.holders).toEqual({ ok: false, error: 'HTTP 503' });
    const queue = (await call('GET', '/v1/ops/listings?status=pending', 'viewer')).body.listings as { id: string; evidence_failed: string[] }[];
    expect(queue.find((l) => l.id === id)!.evidence_failed).toEqual(['holders']);
    const clean = await call('POST', '/v1/ops/listings', 'alice', { mint: MINT, note: 'All sources answered' });
    expect((await call('GET', '/v1/ops/listings?status=pending', 'viewer')).body.listings.find((l: { id: string }) => l.id === clean.body.id).evidence_failed).toEqual([]);
    expect((await call('GET', '/v1/ops/listings/does-not-exist', 'viewer')).status).toBe(404);
    expect((await call('GET', `/v1/ops/listings/${id}`, null)).status).toBe(401);
  });

  it('refuses a listing with nothing to list, and a bad address', async () => {
    expect((await call('POST', '/v1/ops/listings', 'alice', { note: 'nothing here' })).status).toBe(400);
    expect((await call('POST', '/v1/ops/listings', 'alice', { mint: 'not-an-address-but-long-enough-for-length-x', note: 'bad' })).status).toBe(400);
  });

  it('runs an incident from the monitor to resolution, and does not open the same one twice', async () => {
    const hook = (payload: unknown, secret = 'hook-secret-123') => app.inject({ method: 'POST', url: `/v1/ops/hooks/monitor/${secret}`, payload: payload as never }).then((r) => ({ status: r.statusCode, body: r.json() }));
    expect((await hook({ kind: 'finding', body: {} }, 'wrong')).status).toBe(401);
    expect((await hook({ nonsense: true })).status).toBe(400);
    const ev = { kind: 'incident', at: '2026-10-13T00:00:00Z', body: { event: 'protocol paused by the monitor', signature: 'sig123', reason: 'upgrade authority moved' } };
    const first = await hook(ev);
    expect(first.body).toMatchObject({ accepted: true, fresh: true });
    const again = await hook(ev);
    expect(again.body).toMatchObject({ fresh: false, incident: first.body.incident });
    expect((await hook({ kind: 'finding', body: { severity: 'warning', check: 'c', subject: 's', streak: 9, needed: null, message: 'm' } })).body.incident).toBeNull();
    expect((await hook({ kind: 'finding', body: { severity: 'critical', check: 'program-integrity', subject: 'F5k8:authority', streak: 1, needed: 3, message: 'm' } })).body.incident).toBeNull(); // not yet persisted
    const persisted = await hook({ kind: 'finding', body: { severity: 'critical', check: 'program-integrity', subject: 'F5k8:authority', streak: 3, needed: 3, message: 'the upgrade authority moved' } });
    expect(persisted.body.fresh).toBe(true);
    expect((await hook({ kind: 'decision', body: { decision: 'pause-failed', error: 'rpc down' } })).body.fresh).toBe(true);
    expect((await hook({ kind: 'decision', body: { decision: 'would-pause' } })).body.incident).toBeNull();

    const id = first.body.incident;
    expect((await call('POST', `/v1/ops/incidents/${id}/ack`, 'alice')).body.state).toBe('acknowledged');
    expect((await call('POST', `/v1/ops/incidents/${id}/ack`, 'alice')).status).toBe(409);
    expect((await call('POST', `/v1/ops/incidents/${id}/resolve`, 'root', { resolution: 'short' })).status).toBe(400);
    expect((await call('POST', `/v1/ops/incidents/${id}/resolve`, 'root', { resolution: 'Authority returned to the Squads vault; protocol unpaused by the admin.' })).body.state).toBe('resolved');
    // Once resolved, the same event opens a new incident.
    expect((await hook(ev)).body.fresh).toBe(true);
    const open = await call('GET', '/v1/ops/incidents?state=open', 'viewer');
    expect(open.body.incidents.length).toBeGreaterThanOrEqual(3);
    expect((await call('POST', '/v1/ops/incidents', 'alice', { title: 'Manual: user reports a wrong fee', severity: 'warning' })).status).toBe(201);
    expect((await call('POST', '/v1/ops/incidents', 'alice', { title: 'x', severity: 'warning' })).status).toBe(400);
  });

  it('keeps a compliance case with notes that are never edited, and closes it only by an admin', async () => {
    const c = await call('POST', '/v1/ops/cases', 'alice', { kind: 'sanctions', subject: MINT, summary: 'A screening provider flagged a holder; review needed' });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await call('POST', `/v1/ops/cases/${id}/notes`, 'alice', { text: 'Asked the provider for the match basis.' })).status).toBe(201);
    expect((await call('POST', `/v1/ops/cases/${id}/notes`, 'bob', { text: 'Match is a name collision; the dates of birth differ.' })).status).toBe(201);
    const got = await call('GET', `/v1/ops/cases/${id}`, 'viewer');
    expect(got.body.notes.map((n: { author: string }) => n.author)).toEqual(['alice', 'bob']);
    expect((await call('POST', `/v1/ops/cases/${id}/close`, 'bob', { resolution: 'cleared as a name collision' })).status).toBe(403);
    expect((await call('POST', `/v1/ops/cases/${id}/close`, 'root', { resolution: 'Cleared as a name collision; evidence attached to the case.' })).body.status).toBe('closed');
    expect((await call('POST', `/v1/ops/cases/${id}/notes`, 'alice', { text: 'too late' })).status).toBe(409);
    // Twelve notes read back in the order written (a text sort of the ids would put 10 before 2).
    const many = (await call('POST', '/v1/ops/cases', 'alice', { kind: 'other', subject: 'ordering-check', summary: 'twelve notes, read back in order' })).body.id;
    for (let i = 1; i <= 12; i++) await call('POST', `/v1/ops/cases/${many}/notes`, 'alice', { text: `note ${i}` });
    expect((await call('GET', `/v1/ops/cases/${many}`, 'viewer')).body.notes.map((n: { text: string }) => n.text)).toEqual(Array.from({ length: 12 }, (_, i) => `note ${i + 1}`));
    expect((await call('GET', '/v1/ops/cases/nope', 'viewer')).status).toBe(404);
    // The audit log says a note was added, not what it said.
    const log = (await call('GET', '/v1/ops/log?limit=500', 'viewer')).body.entries.filter((e: { action: string; subject: string }) => e.action === 'case.note' && e.subject === id);
    expect(log).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain('name collision; the dates');
  });

  it('chains every action, finds an edited or a removed entry, and signs its head', async () => {
    const check = await verifyChain(db);
    expect(check.ok).toBe(true);
    expect(check.length).toBeGreaterThan(8);
    const log = (await call('GET', '/v1/ops/log?limit=500', 'viewer')).body.entries;
    expect(log[0].prevHash).toBe(GENESIS);
    for (let i = 1; i < log.length; i++) expect(log[i].prevHash).toBe(log[i - 1].hash);
    expect(log.map((e: { actor: string }) => e.actor)).toEqual(expect.arrayContaining(['alice', 'bob', 'root', 'monitor']));
    expect(entryHash(GENESIS, { at: 1, actor: 'a', action: 'x', subject: 's', detail: {} })).toMatch(/^[0-9a-f]{64}$/);

    const head = await call('GET', '/v1/ops/log/head', 'root');
    expect(head.body).toMatchObject({ signed: true, check: { ok: true } });
    expect(head.body.document.signer).toBe(signerAddress);
    expect(head.body.document.body.head).toBe(check.head);
    expect((await verifyDocument(head.body.document)).ok).toBe(true);

    // Tamper: edit one entry's detail, then delete another.
    const mid = log[Math.floor(log.length / 2)];
    await db.query("UPDATE ops_log SET detail = '{\"edited\":true}' WHERE seq = $1", [mid.seq]);
    const edited = await verifyChain(db);
    expect(edited).toMatchObject({ ok: false, brokenAt: { seq: mid.seq } });
    expect(edited.brokenAt!.why).toMatch(/edited/);
    expect((await call('GET', '/v1/ops/log/head', 'root')).body).toMatchObject({ signed: false, check: { ok: false } }); // a broken chain is never signed
    await db.query('UPDATE ops_log SET detail = $2 WHERE seq = $1', [mid.seq, JSON.stringify(mid.detail)]);
    expect((await verifyChain(db)).ok).toBe(true);
    await db.query('DELETE FROM ops_log WHERE seq = $1', [mid.seq]);
    const removed = await verifyChain(db);
    expect(removed.ok).toBe(false);
    expect(removed.brokenAt!.why).toMatch(/removed or inserted/);
  });

  it('reads the end of the log newest first, in pages that join up', async () => {
    const all = (await call('GET', '/v1/ops/log?limit=500', 'viewer')).body.entries as { seq: number; hash: string }[];
    expect(all.length).toBeGreaterThan(10);
    const newest = (await call('GET', '/v1/ops/log?order=desc&limit=5', 'viewer')).body.entries as { seq: number; hash: string }[];
    expect(newest.map((e) => e.seq)).toEqual(all.slice(-5).reverse().map((e) => e.seq));
    const older = (await call('GET', `/v1/ops/log?before=${newest.at(-1)!.seq}&limit=5`, 'viewer')).body.entries as { seq: number }[];
    expect(older.map((e) => e.seq)).toEqual(all.slice(-10, -5).reverse().map((e) => e.seq));
    expect((await call('GET', `/v1/ops/log?before=${all[0]!.seq}`, 'viewer')).body.entries).toEqual([]);
    expect((await call('GET', '/v1/ops/log?order=sideways', 'viewer')).status).toBe(400);
    expect((await call('GET', '/v1/ops/log?order=desc&after=3', 'viewer')).status).toBe(400);
    expect((await call('GET', '/v1/ops/log?order=asc&before=9', 'viewer')).status).toBe(400);
    expect((await call('GET', '/v1/ops/log?before=0', 'viewer')).status).toBe(400);
  });

  it('serialises concurrent actions into one valid chain', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db2 = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrate(db2);
    const a2 = Fastify();
    registerOps(a2, { db: db2 }, { tokens: entries });
    await a2.ready();
    await Promise.all(Array.from({ length: 24 }, (_, i) => a2.inject({ method: 'POST', url: '/v1/ops/cases', headers: { authorization: `Bearer ${TOK.alice}` }, payload: { kind: 'support', subject: `wallet-${i}`, summary: `concurrent case number ${i}` } })));
    const check = await verifyChain(db2);
    expect(check, JSON.stringify(check)).toMatchObject({ ok: true, length: 24 });
    await a2.close();
    await db2.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('shows a review pack for a cross, and says when no evidence source is configured', async () => {
    const r = await call('GET', `/v1/ops/review/cross/${CROSS}`, 'viewer');
    expect(r.status).toBe(200);
    expect(gathered.at(-1)).toEqual({ cross: CROSS });
    expect((await call('GET', '/v1/ops/review/cross/nope', 'viewer')).status).toBe(400);
    const noEv = Fastify();
    registerOps(noEv, { db }, { tokens: entries });
    await noEv.ready();
    expect((await noEv.inject({ method: 'GET', url: `/v1/ops/review/cross/${CROSS}`, headers: { authorization: `Bearer ${TOK.viewer}` } })).statusCode).toBe(503);
    await noEv.close();
  });
});

describe('apiEvidence', () => {
  it('gathers each source alone, so one failing source does not hide the rest', async () => {
    const f = (async (u: string) => (u.includes('/holders') ? new Response('busy', { status: 503 }) : u.includes('/duplicates') ? Promise.reject(new Error('socket hang up')) : new Response(JSON.stringify({ ok: u }), { status: 200 }))) as unknown as typeof fetch;
    const ev = await apiEvidence('https://api.test/', f)({ mint: MINT });
    expect(Object.keys(ev)).toEqual(['safety', 'authenticity', 'duplicates', 'holders', 'supply', 'backing']);
    expect(ev.safety).toEqual({ ok: true, data: { ok: `https://api.test/v1/tokens/${MINT}/safety` } });
    expect(ev.holders).toEqual({ ok: false, error: 'HTTP 503: busy' });
    expect(ev.duplicates).toEqual({ ok: false, error: 'socket hang up' });
    const cross = await apiEvidence('https://api.test', f)({ cross: CROSS });
    expect(Object.keys(cross)).toEqual(['cross', 'proof', 'conflicts', 'organic', 'rating']);
  });
});
