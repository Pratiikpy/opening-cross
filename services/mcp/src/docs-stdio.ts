#!/usr/bin/env node
// The docs MCP server over stdio, or over HTTP when OPENING_CROSS_DOCS_PORT is set.
//   OPENING_CROSS_DOCS_DIR      repository root to read (default: this checkout)
//   OPENING_CROSS_DOCS_CORPUS   a corpus file written by `pnpm --filter @opening-cross/mcp docs:corpus`; used instead of the directory
//   OPENING_CROSS_DOCS_PORT     serve MCP over HTTP (POST /mcp) on this port instead of stdio; OPENING_CROSS_DOCS_HOST defaults to 127.0.0.1
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DocsIndex, buildIndex } from './docs-index.js';
import { DOCS_SERVER_NAME, createDocsServer } from './docs-server.js';

const root = process.env.OPENING_CROSS_DOCS_DIR ?? fileURLToPath(new URL('../../../', import.meta.url));
const corpusFile = process.env.OPENING_CROSS_DOCS_CORPUS;
const index = corpusFile ? new DocsIndex(JSON.parse(readFileSync(corpusFile, 'utf8'))) : buildIndex(root);
process.stderr.write(`${JSON.stringify({ level: 'info', msg: `${DOCS_SERVER_NAME} mcp`, documents: index.docs.length, sections: index.sectionCount, revision: index.revision })}\n`);

const port = process.env.OPENING_CROSS_DOCS_PORT;
if (port) {
  const handler = createMcpHandler(() => createDocsServer(index));
  const host = process.env.OPENING_CROSS_DOCS_HOST ?? '127.0.0.1';
  const http = createHttpServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP is served at POST /mcp' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(`http://${req.headers.host ?? host}${req.url}`, { method: req.method ?? 'POST', headers, ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}) });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  http.listen(Number(port), host, () => process.stderr.write(`${JSON.stringify({ level: 'info', msg: 'listening', url: `http://${host}:${port}/mcp` })}\n`));
} else {
  const stdio = serveStdio(() => createDocsServer(index));
  const shutdown = async () => {
    await stdio.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
}
