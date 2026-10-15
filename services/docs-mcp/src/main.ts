// The documentation service. Environment (all optional):
//   DOCS_PORT, DOCS_HOST            listen address, default 8793 and 127.0.0.1
//   DOCS_DIR                        repository root to read, default this checkout
//   DOCS_CORPUS                     a corpus file from `pnpm --filter @opening-cross/mcp docs:corpus`, used instead of the directory
//   DOCS_KINDS                      comma-separated kinds to publish; default everything except runbook and security
//   DOCS_PUBLIC_URL                 the address this service is reached at, written into /llms.txt
//   DOCS_RATE_PER_MINUTE            requests per client per minute, default 120, 0 turns the limit off
//   DOCS_TRUST_PROXY=1              take the client address from X-Forwarded-For (only behind a proxy that sets it)
import { type IncomingMessage, createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDocsApp } from './app.js';
import { loadIndex, parseKinds } from './corpus.js';

const env = process.env;
const index = loadIndex({ root: env.DOCS_DIR ?? fileURLToPath(new URL('../../../', import.meta.url)), corpusFile: env.DOCS_CORPUS, kinds: parseKinds(env.DOCS_KINDS) });
const app = createDocsApp({ index, ...(env.DOCS_PUBLIC_URL ? { publicUrl: env.DOCS_PUBLIC_URL } : {}), perMinute: env.DOCS_RATE_PER_MINUTE === undefined ? 120 : Number(env.DOCS_RATE_PER_MINUTE) });
const trustProxy = env.DOCS_TRUST_PROXY === '1';

const clientOf = (req: IncomingMessage): string => {
  if (trustProxy) {
    const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
};

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  // The body is read here only up to the limit the app enforces, so an oversized upload is cut off rather than buffered whole.
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 300 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'the request is too large' }));
      req.destroy();
      return;
    }
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const body = chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) });
  const response = await app.fetch(request, clientOf(req));
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
});

const port = Number(env.DOCS_PORT ?? 8793);
const host = env.DOCS_HOST ?? '127.0.0.1';
server.listen(port, host, () => console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'opening-cross docs service', url: `http://${host}:${port}`, documents: index.docs.length, sections: index.sectionCount, revision: index.revision, rate: env.DOCS_RATE_PER_MINUTE ?? '120' })));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
