// The operations console in the web app: the proxy that reaches the service, the client that speaks to it, and the checks a form makes
// before sending. The proxy route is run for real against a real HTTP server standing in for the service, so what it forwards and what
// it refuses is observed on the wire.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET, POST } from '../../app/ops/api/[...path]/route';
import { MAX_BODY_BYTES, forwardHeaders, opsServiceUrl, upstreamFor } from './proxy';
import {
  OPS_API_BASE,
  OpsApiError,
  allows,
  caseProblem,
  createOpsClient,
  decisionProblem,
  evidenceSummary,
  failedSources,
  incidentProblem,
  linkedWithinPage,
  listingProblem,
  noteProblem,
  olderThan,
  resolutionProblem,
  shorten,
  when,
  type LogEntry,
} from './ops-client';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = 'http://127.0.0.1:8792';

describe('upstreamFor', () => {
  const ok = (segs: string[], search = '') => upstreamFor(BASE, segs, search);
  it('reaches the console routes and keeps the query', () => {
    expect(ok(['v1', 'ops', 'me'])).toEqual({ ok: true, url: `${BASE}/v1/ops/me` });
    expect(ok(['v1', 'ops', 'listings'], '?status=pending')).toEqual({ ok: true, url: `${BASE}/v1/ops/listings?status=pending` });
    expect(ok(['v1', 'ops', 'log'], '?order=desc&before=40&limit=50')).toMatchObject({ ok: true, url: `${BASE}/v1/ops/log?order=desc&before=40&limit=50` });
    expect(ok(['v1', 'ops', 'review', 'cross', MINT])).toMatchObject({ ok: true });
  });
  it('serves nothing else: other service routes, the monitor webhook, traversal and encoded separators', () => {
    expect(ok(['v1', 'health'])).toMatchObject({ ok: false, status: 404 });
    expect(ok(['v1', 'ops'])).toMatchObject({ ok: false, status: 404 });
    expect(ok([])).toMatchObject({ ok: false, status: 404 });
    expect(ok(['v1', 'ops', 'hooks', 'monitor', 'the-secret'])).toMatchObject({ ok: false, status: 404 });
    expect(ok(['v1', 'ops', '..', 'x'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', '.', 'x'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', '', 'x'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', 'a/b'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', 'a\\b'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', '%2e%2e', 'x'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', 'x%2Fy'])).toMatchObject({ ok: false, status: 400 });
    expect(ok(['v1', 'ops', 'a\u0000b'])).toMatchObject({ ok: false, status: 400 });
  });
  it('keeps a path prefix of the service and cannot leave the service host', () => {
    expect(upstreamFor('http://10.0.0.5:8792/internal', ['v1', 'ops', 'me'], '')).toEqual({ ok: true, url: 'http://10.0.0.5:8792/internal/v1/ops/me' });
    // A host smuggled in as a segment is encoded into the path, never parsed as an authority.
    const r = upstreamFor(BASE, ['v1', 'ops', '@evil.example', 'x'], '');
    expect(r.ok && new URL(r.url).host).toBe('127.0.0.1:8792');
  });
});

describe('forwardHeaders and the service address', () => {
  it('passes the token and the content type and nothing else', () => {
    const h = forwardHeaders(new Headers({ authorization: 'Bearer abc', cookie: 'session=1', 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json', origin: 'https://evil.example' }));
    expect([...h.keys()].sort()).toEqual(['accept', 'authorization', 'content-type']);
    expect(h.get('authorization')).toBe('Bearer abc');
    expect([...forwardHeaders(new Headers()).keys()]).toEqual(['accept']);
  });
  it('defaults to the private address and trims a trailing slash', () => {
    expect(opsServiceUrl({})).toBe('http://127.0.0.1:8792');
    expect(opsServiceUrl({ OPS_CONSOLE_URL: 'http://ops.internal:9000//' })).toBe('http://ops.internal:9000');
  });
});

describe('the /ops/api route against a real HTTP server', () => {
  let server: Server;
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let mode: 'echo' | 'slow' | 'down' = 'echo';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url?.startsWith('/v1/ops/teapot')) return void res.writeHead(418, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'I am a teapot' }));
        if (req.url?.startsWith('/v1/ops/redirect')) return void res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.OPS_CONSOLE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.OPS_CONSOLE_URL;
    await new Promise((r) => server.close(r));
  });
  const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
  const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://web.test/ops/api/${path}`, init);

  it('forwards a read with the token and the query, and drops the cookie', async () => {
    seen.length = 0;
    const res = await GET(req('v1/ops/listings?status=pending', { headers: { authorization: 'Bearer token-token-token-1', cookie: 'a=b' } }), ctx('v1', 'ops', 'listings'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/ops/listings?status=pending' });
    expect(seen[0]!.headers.authorization).toBe('Bearer token-token-token-1');
    expect(seen[0]!.headers.cookie).toBeUndefined();
  });
  it('forwards a write with its body', async () => {
    seen.length = 0;
    const body = JSON.stringify({ kind: 'fraud', subject: 'wallet-1', summary: 'a summary of the case' });
    const res = await POST(req('v1/ops/cases', { method: 'POST', headers: { authorization: 'Bearer token-token-token-1', 'content-type': 'application/json' }, body }), ctx('v1', 'ops', 'cases'));
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/ops/cases', body });
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });
  it('hands back the service\'s own status and error unchanged', async () => {
    const res = await GET(req('v1/ops/teapot'), ctx('v1', 'ops', 'teapot'));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'I am a teapot' });
  });
  it('does not follow a redirect from the service', async () => {
    const res = await GET(req('v1/ops/redirect'), ctx('v1', 'ops', 'redirect'));
    expect(res.status).toBe(302);
  });
  it('refuses the webhook and other routes without calling the service', async () => {
    seen.length = 0;
    expect((await POST(req('v1/ops/hooks/monitor/x', { method: 'POST', body: '{}' }), ctx('v1', 'ops', 'hooks', 'monitor', 'x'))).status).toBe(404);
    expect((await GET(req('v1/health'), ctx('v1', 'health'))).status).toBe(404);
    expect((await GET(req('v1/ops/%2e%2e/x'), ctx('v1', 'ops', '..', 'x'))).status).toBe(400);
    expect(seen).toEqual([]);
  });
  it('refuses a body above the limit before forwarding it', async () => {
    seen.length = 0;
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await POST(req('v1/ops/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }), ctx('v1', 'ops', 'cases'));
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });
  it('says so when the service is down', async () => {
    const was = process.env.OPS_CONSOLE_URL;
    process.env.OPS_CONSOLE_URL = 'http://127.0.0.1:1';
    try {
      const res = await GET(req('v1/ops/me'), ctx('v1', 'ops', 'me'));
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/could not be reached/);
    } finally {
      process.env.OPS_CONSOLE_URL = was;
    }
  });
});

describe('the console client', () => {
  type Call = { url: string; init: RequestInit };
  const fake = (respond: (c: Call) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    return { calls, fetch: async (url: string, init: RequestInit = {}) => { const c = { url, init }; calls.push(c); return respond(c); } };
  };
  const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the token on every call and builds the queries', async () => {
    const f = fake(() => jsonRes({ listings: [], incidents: [], cases: [], entries: [] }));
    const c = createOpsClient('tok-tok-tok-tok-tok-1', f.fetch);
    await c.listings();
    await c.listings('needs-info');
    await c.incidents('open');
    await c.cases('closed');
    await c.log();
    await c.log({ before: 41, limit: 20 });
    expect(f.calls.map((x) => x.url)).toEqual([
      `${OPS_API_BASE}/listings`,
      `${OPS_API_BASE}/listings?status=needs-info`,
      `${OPS_API_BASE}/incidents?state=open`,
      `${OPS_API_BASE}/cases?status=closed`,
      `${OPS_API_BASE}/log?order=desc&limit=50`,
      `${OPS_API_BASE}/log?order=desc&before=41&limit=20`,
    ]);
    for (const call of f.calls) expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer tok-tok-tok-tok-tok-1');
  });
  it('posts the bodies the service expects', async () => {
    const f = fake(() => jsonRes({ id: 'x', status: 'pending', evidence: {} }));
    const c = createOpsClient('tok-tok-tok-tok-tok-1', f.fetch);
    await c.openListing({ mint: MINT, note: 'why' });
    await c.decideListing('abc', { decision: 'approve', reason: 'a long enough reason', acknowledgeMissingEvidence: true });
    await c.openIncident({ title: 'Wrong fee', severity: 'warning', note: 'seen twice' });
    await c.openIncident({ title: 'No note', severity: 'info' });
    await c.ackIncident('i 1');
    await c.resolveIncident('i1', 'Fixed by the admin');
    await c.openCase({ kind: 'fraud', subject: 'wallet-1', summary: 'a summary of the case' });
    await c.addNote('c1', 'a note');
    await c.closeCase('c1', 'cleared after review');
    const posted = f.calls.map((x) => [x.init.method, x.url.replace(OPS_API_BASE, ''), x.init.body ? JSON.parse(x.init.body as string) : null]);
    expect(posted).toEqual([
      ['POST', '/listings', { mint: MINT, note: 'why' }],
      ['POST', '/listings/abc/decision', { decision: 'approve', reason: 'a long enough reason', acknowledgeMissingEvidence: true }],
      ['POST', '/incidents', { title: 'Wrong fee', severity: 'warning', detail: { note: 'seen twice' } }],
      ['POST', '/incidents', { title: 'No note', severity: 'info' }],
      ['POST', '/incidents/i%201/ack', {}],
      ['POST', '/incidents/i1/resolve', { resolution: 'Fixed by the admin' }],
      ['POST', '/cases', { kind: 'fraud', subject: 'wallet-1', summary: 'a summary of the case' }],
      ['POST', '/cases/c1/notes', { text: 'a note' }],
      ['POST', '/cases/c1/close', { resolution: 'cleared after review' }],
    ]);
  });
  it('turns failures into errors a person can read, and knows when the session is over', async () => {
    const c401 = createOpsClient('tok-tok-tok-tok-tok-1', fake(() => jsonRes({ error: 'a valid bearer token is required' }, 401)).fetch);
    const e1 = await c401.me().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(OpsApiError);
    expect(e1).toMatchObject({ status: 401, message: 'a valid bearer token is required', signedOut: true });
    const c403 = createOpsClient('t'.repeat(20), fake(() => jsonRes({ error: 'this needs the admin role; you are viewer' }, 403)).fetch);
    expect(await c403.verifyLog().catch((e: OpsApiError) => [e.status, e.signedOut, e.message])).toEqual([403, false, 'this needs the admin role; you are viewer']);
    const html = createOpsClient('t'.repeat(20), fake(() => new Response('<html>Bad gateway</html>', { status: 502 })).fetch);
    expect(await html.me().catch((e: OpsApiError) => e.message)).toBe('The console answered with HTTP 502.');
    const down = createOpsClient('t'.repeat(20), (async () => { throw new TypeError('fetch failed'); }) as never);
    expect(await down.me().catch((e: OpsApiError) => [e.status, e.message])).toEqual([0, 'Could not reach the console. Check your connection and try again.']);
  });
});

describe('what a form checks before it sends', () => {
  it('ranks roles', () => {
    expect(allows('admin', 'reviewer')).toBe(true);
    expect(allows('reviewer', 'admin')).toBe(false);
    expect(allows('viewer', 'viewer')).toBe(true);
  });
  it('a listing needs an address and a reason', () => {
    expect(listingProblem({ mint: '', cross: '', note: 'why not' })).toMatch(/mint, a cross/);
    expect(listingProblem({ mint: 'nope', cross: '', note: 'why not' })).toMatch(/mint must be/);
    expect(listingProblem({ mint: '', cross: '0OIl', note: 'why not' })).toMatch(/cross must be/);
    expect(listingProblem({ mint: MINT, cross: '', note: 'ab' })).toMatch(/3 to 1,000/);
    expect(listingProblem({ mint: MINT, cross: '', note: ' why ' })).toBeNull();
  });
  it('a decision needs a choice, a reason, and an acknowledgement when evidence is missing', () => {
    const base = { decision: 'approve' as const, reason: 'long enough reason', failedSources: [] as string[], acknowledged: false };
    expect(decisionProblem({ ...base, decision: '' })).toMatch(/Choose/);
    expect(decisionProblem({ ...base, reason: 'short' })).toMatch(/at least 10/);
    expect(decisionProblem({ ...base, failedSources: ['holders'] })).toMatch(/holders/);
    expect(decisionProblem({ ...base, failedSources: ['holders'], acknowledged: true })).toBeNull();
    expect(decisionProblem({ ...base, decision: 'reject', failedSources: ['holders'] })).toBeNull();
    expect(decisionProblem(base)).toBeNull();
  });
  it('incidents, cases, notes and resolutions have the service\'s limits', () => {
    expect(incidentProblem({ title: 'x', note: '' })).toMatch(/3 to 200/);
    expect(incidentProblem({ title: 'Wrong fee shown', note: 'n'.repeat(4001) })).toMatch(/too long/);
    expect(incidentProblem({ title: 'Wrong fee shown', note: '' })).toBeNull();
    expect(caseProblem({ subject: 'ab', summary: 'a long enough summary' })).toMatch(/3 to 100/);
    expect(caseProblem({ subject: 'wallet-1', summary: 'short' })).toMatch(/10 to 2,000/);
    expect(caseProblem({ subject: 'wallet-1', summary: 'a long enough summary' })).toBeNull();
    expect(noteProblem('  ')).toMatch(/1 to 4,000/);
    expect(noteProblem('ok')).toBeNull();
    expect(resolutionProblem('too short')).toMatch(/at least 10/);
    expect(resolutionProblem('this is long enough')).toBeNull();
  });
});

describe('display helpers', () => {
  it('formats times and shortens addresses', () => {
    expect(when('1800000000')).toBe('2027-01-15 08:00:00 UTC');
    expect(when(0)).toBe('1970-01-01 00:00:00 UTC');
    expect(when(null)).toBe('');
    expect(when('not a number')).toBe('not a number');
    expect(shorten(MINT)).toBe('EPjFWd…wyTDt1v'.replace('wyTDt1v', MINT.slice(-6)));
    expect(shorten('short')).toBe('short');
    expect(shorten(null)).toBe('');
  });
  it('names the failed evidence sources and summarises the rest', () => {
    const ev = { safety: { ok: true, data: { verdict: 'disclosures', score: 3, nested: { a: 1 } } }, holders: { ok: false, error: 'HTTP 503' }, backing: { ok: false } };
    expect(failedSources(ev)).toEqual(['backing', 'holders']);
    expect(failedSources(undefined)).toEqual([]);
    expect(evidenceSummary(ev.safety)).toBe('verdict: disclosures · score: 3');
    expect(evidenceSummary(ev.holders)).toBe('HTTP 503');
    expect(evidenceSummary(ev.backing)).toBe('could not be gathered');
    expect(evidenceSummary({ ok: true, data: { only: { nested: true } } })).toBe('structured data (open to read)');
    expect(evidenceSummary({ ok: true })).toBe('no data');
  });
  it('pages the log backwards and notices an entry that does not follow', () => {
    const e = (seq: number, prevHash: string, hash: string): LogEntry => ({ seq, at: seq, actor: 'a', action: 'x', subject: 's', detail: {}, prevHash, hash });
    const page = [e(5, 'h4', 'h5'), e(4, 'h3', 'h4'), e(3, 'h2', 'h3')];
    expect(olderThan(page)).toBe(3);
    expect(olderThan([e(1, '0', 'h1')])).toBeNull();
    expect(olderThan([])).toBeNull();
    expect(linkedWithinPage(page)).toEqual([true, true, true]);
    expect(linkedWithinPage([e(5, 'hX', 'h5'), e(4, 'h3', 'h4')])).toEqual([false, true]);
  });
});
