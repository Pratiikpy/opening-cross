// The agent skill (docs/agent-skill/opening-cross/SKILL.md) is documentation an agent will act on, so it is held to the code: every
// route it lists must be registered in services/api/src/server.ts with the same method, every route the server registers must be
// listed, the program ids must be the ones in Anchor.toml, and every file or package it points at must exist. Nothing here needs
// a validator, a database or LiteSVM; it only reads files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const SKILL = read('docs/agent-skill/opening-cross/SKILL.md');
const SERVER = read('services/api/src/server.ts');

type Route = { method: string; path: string };
const key = (r: Route) => `${r.method} ${r.path}`;

/** Routes registered with `app.get('/v1/...'` and `app.post('/v1/...'`; the stream is the one WebSocket route. */
function serverRoutes(): Route[] {
  const out: Route[] = [];
  for (const m of SERVER.matchAll(/app\.(get|post)\(\s*'(\/v1\/[^']*)'(\s*,\s*\{\s*websocket:\s*true\s*\})?/g)) {
    out.push({ method: m[3] ? 'WS' : m[1]!.toUpperCase(), path: m[2]! });
  }
  return out;
}

function skillRoutes(): Route[] {
  const block = /<!-- routes:begin -->([\s\S]*?)<!-- routes:end -->/.exec(SKILL)?.[1];
  if (!block) throw new Error('SKILL.md has no routes block');
  const out: Route[] = [];
  for (const line of block.split('\n')) {
    const m = /^\|\s*(GET|POST|WS)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) out.push({ method: m[1]!, path: m[2]! });
  }
  return out;
}

describe('agent skill', () => {
  it('has the frontmatter an agent runtime reads', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1] ?? '';
    expect(fm).toMatch(/^name: opening-cross$/m);
    expect(fm).toMatch(/^description: ".{80,}"$/m);
    expect(fm).toMatch(/^license: Apache-2\.0$/m);
  });

  it('lists only routes that server.ts registers, with the same method', () => {
    const real = new Set(serverRoutes().map(key));
    expect(real.size).toBeGreaterThan(20);
    const listed = skillRoutes();
    expect(listed.length).toBeGreaterThan(20);
    const missing = listed.filter((r) => !real.has(key(r))).map(key);
    expect(missing, 'routes in SKILL.md that server.ts does not register').toEqual([]);
  });

  it('lists every route server.ts registers', () => {
    const listed = new Set(skillRoutes().map(key));
    const undocumented = serverRoutes().filter((r) => !listed.has(key(r))).map(key);
    expect(undocumented, 'routes in server.ts that SKILL.md does not list').toEqual([]);
  });

  it('lists no route twice', () => {
    const keys = skillRoutes().map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('names the program ids that Anchor.toml deploys on devnet', () => {
    const toml = read('Anchor.toml');
    const devnet = /\[programs\.devnet\]([\s\S]*?)(\n\[|$)/.exec(toml)?.[1] ?? '';
    const ids = [...devnet.matchAll(/^(\w+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gm)].map((m) => ({ name: m[1]!, id: m[2]! }));
    expect(ids.map((i) => i.name).sort()).toEqual(['cross_calendar', 'cross_core', 'cross_gate', 'cross_settle', 'treasury']);
    for (const { name, id } of ids) {
      expect(SKILL, `${name} id`).toContain(`| \`${name}\` | \`${id}\` |`);
    }
  });

  it('points only at files and workspace packages that exist', () => {
    const files = new Set<string>();
    for (const m of SKILL.matchAll(/`((?:docs|crates|services|packages|examples)\/[A-Za-z0-9_./-]+?)`/g)) files.add(m[1]!.replace(/[.,:;]+$/, ''));
    expect(files.size).toBeGreaterThan(10);
    const absent = [...files].filter((f) => !existsSync(resolve(ROOT, f)));
    expect(absent, 'paths in SKILL.md that do not exist').toEqual([]);

    const pnpmFilters = [...SKILL.matchAll(/--filter (@opening-cross\/[a-z0-9-]+) (\w+)/g)].map((m) => ({ name: m[1]!, script: m[2]! }));
    expect(pnpmFilters.length).toBeGreaterThan(2);
    const packages = new Map<string, { scripts?: Record<string, string> }>();
    for (const dir of ['packages', 'services']) {
      const base = resolve(ROOT, dir);
      for (const entry of existsSync(base) ? readdirSync(base) : []) {
        const pj = resolve(base, entry, 'package.json');
        if (existsSync(pj)) {
          const json = JSON.parse(readFileSync(pj, 'utf8')) as { name: string; scripts?: Record<string, string> };
          packages.set(json.name, json);
        }
      }
    }
    for (const { name, script } of pnpmFilters) {
      expect(packages.has(name), `package ${name}`).toBe(true);
      expect(packages.get(name)!.scripts?.[script], `${name} has script ${script}`).toBeDefined();
    }
  });
});
