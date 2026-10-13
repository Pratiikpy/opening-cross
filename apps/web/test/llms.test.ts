import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const server = read('../../../services/api/src/server.ts');
// The route files of the rules, treasury and settlement layer (docs/api/W3A-rules-treasury-settle.md) register their routes the same way.
const routeFiles = ['rules-tx', 'rules-read', 'treasury-tx', 'settle-tx'].map((f) => read(`../../../services/api/src/routes/${f}.ts`));

/** Every route the API registers: `app.get('/v1/x', ...)` and `app.post(...)`. A WebSocket route is registered with get. */
const registered = new Set([server, ...routeFiles].flatMap((src) => [...src.matchAll(/app\.(get|post)\(\s*'(\/v1\/[^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)));

/** Route lines in the docs: `- GET /v1/crosses?state=&limit=: text`. The query string is documentation, not part of the route. */
function documented(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^- (GET|POST|WS) (\/v1\/\S*?)(?::\s|$)/.exec(line);
    if (!m) continue;
    const path = m[2]!.split('?')[0]!;
    out.push(`${m[1] === 'POST' ? 'POST' : 'GET'} ${path}`);
  }
  return out;
}

describe.each(['llms.txt', 'llms-full.txt'])('%s', (file) => {
  const text = read(`../public/${file}`);

  it('is shaped as llms.txt asks: an H1, then a blockquote summary', () => {
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.find((l) => l.trim() !== '' && !l.startsWith('# '))).toMatch(/^> /);
  });

  it('lists only routes that exist in services/api/src/server.ts and the route files of the rules layer', () => {
    const routes = documented(text);
    expect(routes.length).toBeGreaterThan(15);
    const unknown = routes.filter((r) => !registered.has(r));
    expect(unknown).toEqual([]);
  });

  it('documents every route the server registers', () => {
    const routes = new Set(documented(text));
    const missing = [...registered].filter((r) => !routes.has(r));
    expect(missing).toEqual([]);
  });

  it('says plainly that this is devnet with no audit', () => {
    expect(text).toMatch(/devnet/i);
    expect(text).toMatch(/no external audit/i);
    expect(text).toMatch(/[Nn]o(thing is| mainnet)/);
  });

  it('links only to hosts that belong to the project', () => {
    const hosts = new Set([...text.matchAll(/https?:\/\/([^/\s)]+)/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual(['98-87-59-136.sslip.io', 'github.com', 'opening-bell-psi.vercel.app']);
  });
});

describe('llms.txt links into the repository', () => {
  it('points at documents that exist', () => {
    const text = read('../public/llms.txt') + read('../public/llms-full.txt');
    const paths = [...text.matchAll(/github\.com\/Pratiikpy\/opening-cross\/(?:blob|tree)\/main\/([^\s)`]+)/g)].map((m) => m[1]!.replace(/[.,:]+$/, ''));
    expect(paths.length).toBeGreaterThan(8);
    for (const p of new Set(paths)) {
      expect(existsSync(new URL(`../../../${p}`, import.meta.url)), p).toBe(true);
    }
  });
});
