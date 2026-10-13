// The docs MCP server: ranking on a small known corpus, then the server as an agent meets it, over the repository's real docs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { DocsIndex, MAX_READ_CHARS, buildIndex, createDocsServer, tokenize } from '../src/index.js';

const SPEC = `# OCIP-1

## Clearing rule

The clearing price is the lowest price at which the matched volume is largest. Ties between prices go to the lowest price.

\`\`\`
# not a heading
\`\`\`

## Fees

The protocol fee is charged to the sell side. Bids, cancels and refunds never pay a fee.
`;
const CONFIG = `# Configuration

## OWN_WALLETS

Addresses of wallets we operate. The external-flow scorecard leaves them out.
`;

const corpus = (files: Record<string, string>) =>
  new DocsIndex({ revision: 'abc123', files: Object.entries(files).map(([path, text]) => ({ path, kind: path.includes('spec') ? ('spec' as const) : ('reference' as const), text })) });

describe('docs index', () => {
  const idx = corpus({ 'docs/spec/OCIP-1.md': SPEC, 'docs/CONFIGURATION.md': CONFIG });

  it('splits at headings and ignores a # inside a code fence', () => {
    expect(idx.docs.find((d) => d.path === 'docs/spec/OCIP-1.md')).toMatchObject({ title: 'OCIP-1', sections: ['(top)', 'Clearing rule', 'Fees'].filter((s) => s !== '(top)') });
  });

  it('ranks the section that is about the question first, with file, line and a passage', () => {
    const hits = idx.search('clearing price tie');
    expect(hits[0]).toMatchObject({ path: 'docs/spec/OCIP-1.md', heading: 'Clearing rule', line: 3, kind: 'spec' });
    expect(hits[0]!.snippet).toContain('lowest price');
    expect(idx.search('OWN_WALLETS')[0]).toMatchObject({ path: 'docs/CONFIGURATION.md', heading: 'OWN_WALLETS' });
    expect(idx.search('who pays the fee')[0]!.heading).toBe('Fees');
  });

  it('returns nothing for a query with no usable word or no match, and honours kind and limit', () => {
    expect(idx.search('the of a')).toEqual([]);
    expect(idx.search('zyzzyva')).toEqual([]);
    expect(idx.search('price', { kind: 'reference' })).toEqual([]);
    expect(idx.search('price fee', { limit: 1 })).toHaveLength(1);
  });

  it('reads a whole file, a section, and reports a missing section or file as null or empty', () => {
    expect(idx.read('docs/CONFIGURATION.md')!.text).toContain('Addresses of wallets');
    const s = idx.read('docs/spec/OCIP-1.md', 'fees')!;
    expect(s.text).toContain('## Fees');
    expect(s.text).not.toContain('Clearing rule');
    expect(idx.read('docs/spec/OCIP-1.md', 'nothing here')!.text).toBe('');
    expect(idx.read('../../etc/passwd')).toBeNull();
  });

  it('tokenizes identifiers and drops stop words', () => {
    expect(tokenize('The OWN_WALLETS variable, and 5 bps!')).toEqual(['own_wallets', 'variable', 'bps']);
  });
});

describe('docs index over a directory', () => {
  it('reads only the sources it lists and skips node_modules and research', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocdocs-'));
    mkdirSync(join(root, 'docs/spec'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    mkdirSync(join(root, 'research'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Hello\n\nopening\n');
    writeFileSync(join(root, 'docs/spec/A.md'), '# A\n\nspec text\n');
    writeFileSync(join(root, 'docs/notes.md'), '# Not a source\n');
    writeFileSync(join(root, 'node_modules/x/README.md'), '# dep\n');
    writeFileSync(join(root, 'research/R.md'), '# r\n');
    const idx = buildIndex(root);
    expect(idx.docs.map((d) => d.path)).toEqual(['README.md', 'docs/spec/A.md']);
    expect(idx.revision).toBe('unknown');
  });
});

describe('docs MCP server over the repository docs', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const index = buildIndex(root);

  async function connect() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createDocsServer(index).connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    return client;
  }
  type R = { isError?: boolean; structuredContent?: Record<string, any>; content: { text?: string }[] };

  it('lists three read-only tools and nothing that writes', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['oc_docs_list', 'oc_docs_read', 'oc_docs_search']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)).toBe(true);
    await c.close();
  });

  it('answers real questions from the real documents', async () => {
    expect(index.docs.length).toBeGreaterThan(20);
    const c = await connect();
    const clearing = (await c.callTool({ name: 'oc_docs_search', arguments: { query: 'clearing price lowest price maximum volume' } })) as R;
    expect(clearing.structuredContent!.hits.some((h: { path: string }) => /OCIP-1|0003-clearing-rule/.test(h.path))).toBe(true);
    const own = (await c.callTool({ name: 'oc_docs_search', arguments: { query: 'OWN_WALLETS external flow' } })) as R;
    expect(own.structuredContent!.hits.slice(0, 5).map((h: { path: string }) => h.path)).toContain('docs/CONFIGURATION.md');
    const read = (await c.callTool({ name: 'oc_docs_read', arguments: { path: 'docs/CONFIGURATION.md', section: 'Web app (`apps/web`)' } })) as R;
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent!.text).toContain('NEXT_PUBLIC_API_URL');
    await c.close();
  });

  it('refuses a file outside the corpus, an unknown section and a bad query, with typed errors', async () => {
    const c = await connect();
    const outside = (await c.callTool({ name: 'oc_docs_read', arguments: { path: '.keys/opening-bell-devnet.json' } })) as R;
    expect(outside.isError).toBe(true);
    expect(JSON.parse(outside.content[0]!.text!).error.code).toBe('NOT_FOUND');
    const section = (await c.callTool({ name: 'oc_docs_read', arguments: { path: 'docs/CONFIGURATION.md', section: 'no such heading' } })) as R;
    expect(JSON.parse(section.content[0]!.text!).error.code).toBe('NO_SUCH_SECTION');
    expect(((await c.callTool({ name: 'oc_docs_search', arguments: { query: 'x' } })) as R).isError).toBe(true);
    await c.close();
  });

  it('cuts a very long document and says so', async () => {
    const big = new DocsIndex({ revision: 'r', files: [{ path: 'docs/spec/Big.md', kind: 'spec', text: `# Big\n\n${'word '.repeat(MAX_READ_CHARS)}` }] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createDocsServer(big).connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    const r = (await client.callTool({ name: 'oc_docs_read', arguments: { path: 'docs/spec/Big.md' } })) as R;
    expect(r.structuredContent!.truncated).toBe(true);
    expect(r.structuredContent!.text.length).toBe(MAX_READ_CHARS);
    await client.close();
  });
});

describe('docs MCP entry point', () => {
  const entry = fileURLToPath(new URL('../src/docs-stdio.ts', import.meta.url));

  it('runs over stdio and answers a search with the git revision of this checkout', async () => {
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', entry], stderr: 'ignore' }));
    const r = (await client.callTool({ name: 'oc_docs_search', arguments: { query: 'how a sealed bid is revealed', limit: 3 } })) as { structuredContent?: { revision: string; hits: unknown[] } };
    expect(r.structuredContent!.hits.length).toBeGreaterThan(0);
    expect(r.structuredContent!.revision).toMatch(/^[0-9a-f]{40}$/);
    await client.close();
  }, 60_000);

  it('serves MCP over HTTP at /mcp when a port is given', async () => {
    const { spawn } = await import('node:child_process');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, OPENING_CROSS_DOCS_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stderr!.on('data', (d: Buffer) => d.toString().includes('listening') && resolve());
        child.once('exit', () => reject(new Error('the server exited')));
        setTimeout(() => reject(new Error('the server did not start')), 30_000);
      });
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['oc_docs_list', 'oc_docs_read', 'oc_docs_search']);
      await client.close();
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      child.kill();
    }
  }, 60_000);
});
