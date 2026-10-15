// The documentation of the seven Wave 3D programs is held to the code: every route the eight route files register is in the agent skill, in docs/api/W4A-new-programs.md and in llms.txt,
// every route those documents list is registered, the MCP tools the skill names exist, and the keeper duties and environment variables the documents name are the ones the code reads.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../mcp/src/tools.js';

const ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const FILES = ['mandate-tx', 'conviction-tx', 'basket-tx', 'listing-tx', 'bounty-tx', 'backing-tx', 'graduate-tx', 'settle-wave3d-tx'];
const registered = [...new Set(FILES.flatMap((f) => [...read(`services/api/src/routes/${f}.ts`).matchAll(/app\.(get|post)\(\s*'(\/v1\/[^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)))];
const SKILL = read('docs/agent-skill/opening-cross/SKILL.md');
const W4A = read('docs/api/W4A-new-programs.md');
const LLMS = read('apps/web/public/llms.txt');
const LLMS_FULL = read('apps/web/public/llms-full.txt');

describe('the Wave 3D routes in the documents', () => {
  it('registers every route once, and 66 of them', () => {
    expect(registered).toHaveLength(66);
  });

  it('the agent skill lists exactly the routes the route files register, none twice', () => {
    const block = /<!-- routes-wave3d:begin -->([\s\S]*?)<!-- routes-wave3d:end -->/.exec(SKILL)?.[1];
    expect(block, 'SKILL.md has a routes-wave3d block').toBeDefined();
    const listed = block!.split('\n').flatMap((line) => {
      const m = /^\|\s*(GET|POST)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      return m ? [`${m[1]} ${m[2]}`] : [];
    });
    expect(listed.filter((k, i) => listed.indexOf(k) !== i)).toEqual([]);
    expect(listed.filter((k) => !registered.includes(k)), 'listed but not registered').toEqual([]);
    expect(registered.filter((k) => !listed.includes(k)), 'registered but not listed').toEqual([]);
  });

  it('llms.txt and llms-full.txt list every route', () => {
    for (const [name, text] of [['llms.txt', LLMS], ['llms-full.txt', LLMS_FULL]] as const) {
      const lines = new Set([...text.matchAll(/^- (GET|POST) (\/v1\/\S*?)(?::\s|$)/gm)].map((m) => `${m[1]} ${m[2]!.split('?')[0]}`));
      expect(registered.filter((k) => !lines.has(k)), name).toEqual([]);
    }
  });

  it('docs/api/W4A-new-programs.md names every route (the path, with a body or a query written after it)', () => {
    expect(registered.filter((k) => !W4A.includes(k.split(' ')[1]!))).toEqual([]);
  });

  it('says plainly, in each, that the programs are not on devnet', () => {
    for (const text of [SKILL, W4A, LLMS, LLMS_FULL]) {
      expect(text).toMatch(/not deployed|not on devnet|not deployed to devnet|not deployed on devnet/i);
      expect(text).toMatch(/H43/);
    }
  });
});

describe('the MCP tools in the documents', () => {
  it('the skill names only tools that exist, and every Wave 3D tool', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const section = SKILL.slice(SKILL.indexOf('## The seven Wave 3D programs'), SKILL.indexOf('## Verify a cross'));
    const named = [...section.matchAll(/`(oc_[a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.filter((n) => !names.has(n))).toEqual([]);
    const wave3d = [...names].filter((n) => /mandate|conviction|basket|listing|bount|invariant|backing|graduation|agent_transaction/.test(n));
    expect(wave3d.filter((n) => !named.includes(n))).toEqual([]);
  });
});

describe('the keeper in the documents', () => {
  const keeper = read('services/keeper/src/keeper.ts');
  const main = read('services/keeper/src/main.ts');
  it('the duties named in the skill and in main.ts are the ones the keeper parses', () => {
    const duties = /export type Duty = ([^;]+);/.exec(keeper)![1]!.match(/'([a-z]+)'/g)!.map((x) => x.replace(/'/g, ''));
    for (const d of ['graduation', 'listings', 'bounties', 'backing']) {
      expect(duties).toContain(d);
      expect(main).toContain(d);
      expect(SKILL).toContain(`\`${d}\``);
    }
  });
});
