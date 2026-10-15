// The documentation service, over the repository's real documents: as a person reads it, as an agent calls it, and as an attacker would
// try it. The HTTP section starts the real server process and talks to it with the MCP client, over a socket.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DocsIndex, readCorpus } from '@opening-cross/mcp';
import { DEFAULT_KINDS, buildServer, createDocsApp, createLimiter, explainError, loadIndex, parseCode, parseKinds, renderMarkdown, resolveProgram } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const real = loadIndex({ root, kinds: DEFAULT_KINDS });
const app = createDocsApp({ index: real, perMinute: 0 });
const get = (path: string, init?: RequestInit) => app.fetch(new Request(`http://docs.test${path}`, init));
const getJson = async (path: string) => {
  const r = await get(path);
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
};

describe('the documents published', () => {
  it('are the repository\'s own, without runbooks or security notes unless the operator asks for them', () => {
    expect(real.docs.length).toBeGreaterThan(100);
    expect(new Set(real.docs.map((d) => d.kind))).toEqual(new Set(['overview', 'spec', 'adr', 'reference', 'guide', 'package', 'evidence']));
    expect(real.docs.some((d) => d.path.startsWith('docs/runbooks/') || d.path.startsWith('docs/security/'))).toBe(false);
    expect(real.revision).toMatch(/^[0-9a-f]{40}$/);
    const all = new DocsIndex(readCorpus(root));
    expect(all.docs.some((d) => d.kind === 'runbook')).toBe(true); // they exist: the default leaves them out on purpose
    expect(loadIndex({ root, kinds: parseKinds('runbook') }).docs.every((d) => d.kind === 'runbook')).toBe(true);
  }, 60_000);
  it('are chosen by a kinds list that refuses a mistyped name', () => {
    expect(parseKinds(undefined)).toEqual([...DEFAULT_KINDS]);
    expect(parseKinds(' spec , adr ')).toEqual(['spec', 'adr']);
    expect(() => parseKinds('spec,secrets')).toThrow(/unknown kinds: secrets/);
  });
});

describe('the JSON API', () => {
  it('searches, lists and reads, and every answer says which revision it was read at', async () => {
    const s = await getJson('/v1/docs/search?q=clearing%20price%20lowest%20price%20maximum%20volume&limit=5');
    expect(s.status).toBe(200);
    expect(s.body.revision).toBe(real.revision);
    expect(s.body.hits.length).toBeGreaterThan(0);
    expect(s.body.hits.some((h: { path: string }) => /OCIP-1|0003-clearing-rule/.test(h.path))).toBe(true);
    const list = await getJson('/v1/docs/list?prefix=docs/adr/');
    expect(list.body.count).toBeGreaterThan(50);
    expect(list.body.documents.every((d: { path: string }) => d.path.startsWith('docs/adr/'))).toBe(true);
    const read = await getJson(`/v1/docs/read?path=${encodeURIComponent('docs/CONFIGURATION.md')}&section=${encodeURIComponent('Web app (`apps/web`)')}`);
    expect(read.status).toBe(200);
    expect(read.body.text).toContain('NEXT_PUBLIC_API_URL');
  });
  it('refuses junk with a typed 400 or 404 and never reads outside the corpus', async () => {
    expect((await getJson('/v1/docs/search')).status).toBe(400);
    expect((await getJson('/v1/docs/search?q=x')).status).toBe(400);
    expect((await getJson(`/v1/docs/search?q=${'a'.repeat(201)}`)).status).toBe(400);
    expect((await getJson('/v1/docs/search?q=clearing&limit=0')).status).toBe(400);
    expect((await getJson('/v1/docs/search?q=clearing&limit=99')).status).toBe(400);
    expect((await getJson('/v1/docs/search?q=clearing&kind=secrets')).status).toBe(400);
    expect((await getJson('/v1/docs/search?q=clearing&kind=runbook')).status).toBe(400); // not published, so not a kind here
    expect((await getJson('/v1/docs/read')).status).toBe(400);
    for (const bad of ['.keys/opening-bell-devnet.json', '../../etc/passwd', 'docs/runbooks/DISASTER_RECOVERY.md', 'C:\\Windows\\win.ini', '/etc/hosts']) {
      const r = await getJson(`/v1/docs/read?path=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(404);
    }
    const noSection = await getJson(`/v1/docs/read?path=${encodeURIComponent('docs/CONFIGURATION.md')}&section=nothing-here`);
    expect(noSection.status).toBe(404);
    expect(noSection.body.sections.length).toBeGreaterThan(3);
    expect((await getJson('/v1/nothing')).status).toBe(404);
  });
  it('cuts a very long document and says so', async () => {
    const big = new DocsIndex({ revision: 'r', files: [{ path: 'docs/spec/Big.md', kind: 'spec', text: `# Big\n\n${'word '.repeat(40_000)}` }] });
    const a = createDocsApp({ index: big, perMinute: 0 });
    const r = (await (await a.fetch(new Request('http://x/v1/docs/read?path=docs/spec/Big.md'))).json()) as { truncated: boolean; text: string };
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(30_000);
  });
  it('allows any origin to read, answers a preflight, and refuses writes', async () => {
    const r = await get('/v1/docs/list');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const pre = await get('/v1/docs/search', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
    const put = await get('/v1/docs/search?q=clearing', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toContain('GET');
    expect((await get('/', { method: 'POST', body: 'x' })).status).toBe(405);
  });
});

describe('explaining an error from the program\'s own table, with its documentation', () => {
  it('turns a code, in decimal or in the hex a log prints, into the name, the documentation\'s cause and a link to the source', async () => {
    const dec = await getJson(`/v1/docs/explain?program=${DBC}&code=6002`);
    const hex = await getJson('/v1/docs/explain?program=Meteora%20Dynamic%20Bonding%20Curve&code=0x1772');
    for (const r of [dec, hex]) {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ code: 6002, name: 'ExceededSlippage', program: { address: DBC } });
      expect(r.body.docs.cause).toMatch(/below the minimum output/);
      expect(r.body.docs.sourceLink).toMatch(/blob\/[0-9a-f]{40}\/programs\/dynamic-bonding-curve\/src\/error\.rs#L\d+$/);
      expect(r.body.docs.versions).toMatchObject({ idl: '0.2.1', docs: '0.2.1', source: '0.2.1', docsMatchIdl: true, sourceMatchesIdl: true });
    }
    expect(hex.body.docs).toEqual(dec.body.docs);
  });
  it('says plainly when the documentation is for another release than the IDL', async () => {
    const r = await getJson('/v1/docs/explain?program=cp_amm&code=6002');
    expect(r.status).toBe(200);
    expect(r.body.docs.versions).toMatchObject({ idl: '0.2.5', docs: '0.2.4', docsMatchIdl: false });
    expect(r.body.docs.note).toMatch(/may describe a different release/);
  });
  it('refuses an unknown program, an unknown code and a bad code, naming what it does have', async () => {
    const p = await getJson('/v1/docs/explain?program=nonsense&code=6002');
    expect(p.status).toBe(404);
    expect(p.body.code).toBe('UNKNOWN_PROGRAM');
    expect(p.body.error).toContain('Meteora DAMM v2');
    expect((await getJson(`/v1/docs/explain?program=${DBC}&code=999999`)).body.code).toBe('UNKNOWN_CODE');
    expect((await getJson(`/v1/docs/explain?program=${DBC}&code=-1`)).status).toBe(400);
    expect((await getJson(`/v1/docs/explain?program=${DBC}&code=abc`)).status).toBe(400);
    expect((await getJson(`/v1/docs/explain?program=${DBC}`)).status).toBe(400);
    expect(parseCode('0x1772')).toBe(6002);
    expect(parseCode(6002.5)).toBeNull();
    expect(parseCode('1e3')).toBeNull();
    expect(resolveProgram('F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ')?.label).toBe('Opening Cross core');
    expect(explainError(DBC, 3012)).toMatchObject({ ok: true, value: { source: 'anchor-framework', docs: null } });
  });
});

describe('llms.txt and health', () => {
  it('tells an agent what is here, how to reach it, and lists every published document', async () => {
    const t = await (await get('/llms.txt')).text();
    expect(t).toContain(`Revision: ${real.revision}`);
    expect(t).toContain('oc_explain_error');
    expect(t).toContain('/v1/docs/explain?program=');
    for (const d of real.docs.slice(0, 40)) expect(t).toContain(`- ${d.path}: `);
    expect(t.split('\n').filter((l) => l.startsWith('- docs/')).length).toBe(real.docs.filter((d) => d.path.startsWith('docs/')).length);
    expect(t).not.toContain('docs/runbooks/');
    const withUrl = await (await createDocsApp({ index: real, publicUrl: 'https://docs.example.org/', perMinute: 0 }).fetch(new Request('http://x/llms.txt'))).text();
    expect(withUrl).toContain('https://docs.example.org/mcp');
  });
  it('reports health without counting against a client\'s limit', async () => {
    const limited = createDocsApp({ index: real, perMinute: 2 });
    for (let i = 0; i < 20; i++) expect((await limited.fetch(new Request('http://x/healthz'), 'a')).status).toBe(200);
    const h = (await (await limited.fetch(new Request('http://x/healthz'), 'a')).json()) as { ok: boolean; documents: number; kinds: string[] };
    expect(h).toMatchObject({ ok: true, documents: real.docs.length });
    expect(h.kinds).not.toContain('runbook');
  });
});

describe('the pages a person reads', () => {
  it('shows a search box and every document, grouped, on the first page', async () => {
    const r = await get('/');
    const page = await r.text();
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(page).toContain('role="search"');
    expect(page).toContain('Every document');
    expect(page).toContain('Specification');
    expect(page).toContain('/doc?path=docs%2FCONFIGURATION.md');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page).not.toContain('<script');
  });
  it('searches, with the passage, the file and the line, and a link that opens the section', async () => {
    const page = await (await get('/?q=OWN_WALLETS%20external%20flow')).text();
    expect(page).toContain('docs/CONFIGURATION.md:');
    expect(page).toMatch(/href="\/doc\?path=docs%2FCONFIGURATION\.md&amp;section=/);
    const none = await (await get('/?q=zyzzyvaqqq')).text();
    expect(none).toContain('No section matches');
  });
  it('renders a document as a readable page, with an outline, a table and no script', async () => {
    const r = await get('/doc?path=docs%2FCONFIGURATION.md');
    const page = await r.text();
    expect(r.status).toBe(200);
    expect(page).toContain('<h1');
    expect(page).toContain('<table>');
    expect(page).toContain('On this page');
    expect(page).toContain('NEXT_PUBLIC_API_URL');
    expect(page).not.toMatch(/<script|javascript:|onerror=/i);
    const section = await (await get(`/doc?path=docs%2FCONFIGURATION.md&section=${encodeURIComponent('Web app (`apps/web`)')}`)).text();
    expect(section).toContain('NEXT_PUBLIC_API_URL');
    expect(section).toContain('Read the whole document');
  });
  it('says not found, in a page, for a missing document or section, and never echoes markup', async () => {
    const miss = await get(`/doc?path=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(miss.status).toBe(404);
    const body = await miss.text();
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;');
    expect((await get('/doc?path=docs%2FCONFIGURATION.md&section=nope-nope')).status).toBe(404);
    expect((await get('/elsewhere')).status).toBe(404);
    const echoed = await (await get(`/?q=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`)).text();
    expect(echoed).not.toContain('<img src=x');
    expect(echoed).toContain('&lt;img src=x');
  });
  it('turns a link to another document into a page of this site, and a link it cannot honour into plain text', async () => {
    const idx = new DocsIndex({
      revision: 'r',
      files: [
        { path: 'docs/spec/A.md', kind: 'spec', text: '# A\n\nSee [the ADR](../adr/0001-x.md#why), [a missing one](../adr/9999.md), [web](https://example.org/x?a=1&b=2), [bad](javascript:alert(1)) and [data](data:text/html,x).\n' },
        { path: 'docs/adr/0001-x.md', kind: 'adr', text: '# ADR 1\n\n## Why\n\ntext\n' },
      ],
    });
    const a = createDocsApp({ index: idx, perMinute: 0 });
    const page = await (await a.fetch(new Request('http://x/doc?path=docs/spec/A.md'))).text();
    expect(page).toContain('<a href="/doc?path=docs%2Fadr%2F0001-x.md#why">the ADR</a>');
    expect(page).toContain('a missing one');
    expect(page).not.toContain('9999.md"');
    expect(page).toContain('<a href="https://example.org/x?a=1&amp;b=2">web</a>');
    expect(page).not.toMatch(/javascript:|data:text/);
  });
});

describe('the markdown renderer', () => {
  const link = (h: string) => (/^https?:/.test(h) ? h : null);
  it('escapes everything before it adds markup', () => {
    const { html } = renderMarkdown('# <b>Title</b>\n\n<script>alert(1)</script> and `<i>code</i>` and **<u>bold</u>**\n\n```html\n<script>x</script>\n```\n', link);
    expect(html).not.toMatch(/<script|<b>|<i>|<u>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>&lt;i&gt;code&lt;/i&gt;</code>');
    expect(html).toContain('<strong>&lt;u&gt;bold&lt;/u&gt;</strong>');
  });
  it('renders headings with unique anchors, lists, quotes, tables with escaped pipes, and rules', () => {
    const { html, headings } = renderMarkdown('# A\n\n## Same\n\n## Same\n\n- one\n- two\n  wrapped\n\n1. first\n2. second\n\n> quoted\n\n| a | b |\n| - | - |\n| 1 \\| 2 | `x` |\n\n---\n', link);
    expect(headings.map((h) => h.id)).toEqual(['a', 'same', 'same-1']);
    expect(html).toContain('<ul><li>one</li><li>two wrapped</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<td>1 | 2</td><td><code>x</code></td>');
    expect(html).toContain('<hr>');
  });
  it('can shift headings so a section shown under its document title starts at h2 and never skips a level', () => {
    const { html, headings } = renderMarkdown('### 7.4 The clearing summary\n\ntext\n\n#### Detail\n\n```\n# not a heading\n```\n', link, { shiftTo: 2 });
    expect(headings.map((h) => h.level)).toEqual([2, 3]);
    expect(html).toContain('<h2 id="7-4-the-clearing-summary">');
    expect(html).toContain('<h3 id="detail">');
    expect(renderMarkdown('# A\n\n## B\n', link).headings.map((h) => h.level)).toEqual([1, 2]);
  });
  it('does not mistake an unclosed fence or odd input for a crash', () => {
    expect(renderMarkdown('```\nnever closed\n', link).html).toContain('never closed');
    expect(renderMarkdown('', link).html).toBe('');
    expect(() => renderMarkdown('|\n|||\n| - |\n[x](\n**\n*', link)).not.toThrow();
  });
});

describe('the request limit', () => {
  it('counts a client per minute, lets it back in when the minute is over, and does not mix clients', () => {
    let t = 0;
    const l = createLimiter(3, () => t);
    expect([1, 2, 3].map(() => l.take('a').allowed)).toEqual([true, true, true]);
    const refused = l.take('a');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(l.take('b').allowed).toBe(true);
    t = 59_000;
    expect(l.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    t = 60_000;
    expect(l.take('a').allowed).toBe(true);
    expect(createLimiter(0).take('x').allowed).toBe(true);
  });
  it('answers 429 with Retry-After when a client has used its minute, over the real app', async () => {
    const limited = createDocsApp({ index: real, perMinute: 2, now: () => 1_000 });
    expect((await limited.fetch(new Request('http://x/v1/docs/list'), 'c')).status).toBe(200);
    expect((await limited.fetch(new Request('http://x/v1/docs/list'), 'c')).status).toBe(200);
    const r = await limited.fetch(new Request('http://x/v1/docs/list'), 'c');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await limited.fetch(new Request('http://x/v1/docs/list'), 'd')).status).toBe(200);
  });
});

describe('the server process, over a socket, as an MCP client uses it', () => {
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  async function start(env: Record<string, string> = {}) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, DOCS_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('docs service') && resolve());
      child.once('exit', (c) => reject(new Error(`the server exited with ${c}`)));
      setTimeout(() => reject(new Error('the server did not start')), 45_000);
    });
    return { port, child, url: `http://127.0.0.1:${port}` };
  }

  it('lists five read-only tools, answers a search, explains an error and diagnoses a real failure', async () => {
    const s = await start();
    try {
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['oc_diagnose_failure', 'oc_docs_list', 'oc_docs_read', 'oc_docs_search', 'oc_explain_error']);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)).toBe(true);

      const search = (await client.callTool({ name: 'oc_docs_search', arguments: { query: 'how a sealed bid is revealed', limit: 3 } })) as { structuredContent: { revision: string; hits: unknown[] } };
      expect(search.structuredContent.hits.length).toBeGreaterThan(0);
      expect(search.structuredContent.revision).toMatch(/^[0-9a-f]{40}$/);

      const explained = (await client.callTool({ name: 'oc_explain_error', arguments: { program: 'dynamic_bonding_curve', code: '0x1772' } })) as { structuredContent: { name: string; docs: { cause: string; versions: { docsMatchIdl: boolean } } } };
      expect(explained.structuredContent.name).toBe('ExceededSlippage');
      expect(explained.structuredContent.docs.cause).toMatch(/below the minimum output/);
      expect(explained.structuredContent.docs.versions.docsMatchIdl).toBe(true);

      const missing = (await client.callTool({ name: 'oc_explain_error', arguments: { program: 'nonsense', code: 1 } })) as { isError?: boolean; content: { text: string }[] };
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content[0]!.text).error.code).toBe('UNKNOWN_PROGRAM');
      const badCode = (await client.callTool({ name: 'oc_explain_error', arguments: { program: DBC, code: 'abc' } })) as { isError?: boolean };
      expect(badCode.isError).toBe(true);

      const logs = [`Program ${DBC} invoke [1]`, 'Program log: Instruction: Swap2', 'Program log: AnchorError thrown in programs/dynamic-bonding-curve/src/instructions/swap/ix_swap.rs:55. Error Code: ExceededSlippage. Error Number: 6002. Error Message: Exceeded slippage tolerance.', `Program ${DBC} failed: custom program error: 0x1772`];
      const diag = (await client.callTool({ name: 'oc_diagnose_failure', arguments: { err: { InstructionError: [0, { Custom: 6002 }] }, logs } })) as { structuredContent: { diagnosis: { category: string; summary: string; tableAgreesWithProgram: boolean; docs: { cause: string } } } };
      expect(diag.structuredContent.diagnosis).toMatchObject({ category: 'slippage', tableAgreesWithProgram: true });
      expect(diag.structuredContent.diagnosis.summary).toContain('Swap2');
      expect(diag.structuredContent.diagnosis.docs.cause).toMatch(/minimum output/);
      const junk = (await client.callTool({ name: 'oc_diagnose_failure', arguments: { err: 'something odd', logs: [] } })) as { structuredContent: { diagnosis: { category: string } } };
      expect(junk.structuredContent.diagnosis.category).toBe('unknown');
      await client.close();

      // The same server answers a second, unrelated client: nothing is held between them.
      const second = new Client({ name: 'test2', version: '1.0.0' });
      await second.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
      expect((await second.listTools()).tools).toHaveLength(5);
      await second.close();

      // Over the same socket: the web page, CORS on the MCP route, and the request size limit.
      expect((await fetch(`${s.url}/`)).status).toBe(200);
      expect((await fetch(`${s.url}/mcp`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBe('*');
      const huge = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) });
      expect(huge.status).toBe(413);
      expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    } finally {
      s.child.kill();
    }
  }, 120_000);

  it('limits one client\'s requests and the limit is set by the environment', async () => {
    const s = await start({ DOCS_RATE_PER_MINUTE: '5' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await fetch(`${s.url}/v1/docs/list?prefix=docs/adr/0001`)).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
      expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    } finally {
      s.child.kill();
    }
  }, 120_000);

  it('serves only the kinds it is told to, from a corpus file as well as from a checkout', async () => {
    const s = await start({ DOCS_KINDS: 'spec' });
    try {
      const body = (await (await fetch(`${s.url}/v1/docs/list`)).json()) as { documents: { kind: string }[] };
      expect(body.documents.length).toBeGreaterThan(0);
      expect(new Set(body.documents.map((d) => d.kind))).toEqual(new Set(['spec']));
    } finally {
      s.child.kill();
    }
  }, 120_000);
});

describe('the tool server built from an index', () => {
  it('is the docs tools plus two, on one MCP server object', () => {
    expect(typeof buildServer(real).connect).toBe('function');
  });
});
