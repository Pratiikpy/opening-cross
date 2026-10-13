// The safety, router and replay tools build the API requests their descriptions promise.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/index.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const MINT = 'So11111111111111111111111111111111111111112';

describe('safety, router and replay tools', () => {
  it('oc_check_token_safety reads /v1/tokens/:mint/safety', () => {
    expect(tool('oc_check_token_safety').request({ mint: MINT })).toEqual({ method: 'GET', path: `/v1/tokens/${MINT}/safety` });
    expect(tool('oc_check_token_safety').kind).toBe('read');
  });

  it('oc_quote_route passes the whole order to /v1/router/quote and marks third-party strings untrusted', () => {
    const t = tool('oc_quote_route');
    expect(t.request({ base: MINT, quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', side: 'buy', amount: '2500000' })).toEqual({
      method: 'GET',
      path: `/v1/router/quote?base=${MINT}&quote=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&side=buy&amount=2500000`,
    });
    expect(t.untrusted).toEqual(['/venues/*/route/*', '/excluded/*/reason']);
    expect(t.inputSchema).toMatchObject({ required: ['base', 'quote', 'side', 'amount'] });
  });

  it('oc_get_replay reads one cross when given one and the 30-day listing otherwise', () => {
    const t = tool('oc_get_replay');
    expect(t.request({ cross: MINT })).toEqual({ method: 'GET', path: `/v1/replay/${MINT}` });
    expect(t.request({})).toEqual({ method: 'GET', path: '/v1/replay?days=30' });
    expect(t.request({ days: 7 })).toEqual({ method: 'GET', path: '/v1/replay?days=7' });
  });
});

// The tools added for the rules, treasury and settlement layer, and the claim that every tool's request lands on a route the API registers.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEW_TOOLS: Record<string, { args: Record<string, unknown>; path: string }> = {
  oc_get_cross_rules: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/rules` },
  oc_get_indicative_price: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/indicative` },
  oc_get_ending: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/ending` },
  oc_get_challenges: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/challenges` },
  oc_get_lockups: { args: { owner: MINT }, path: `/v1/owners/${MINT}/lockups` },
  oc_get_halt_state: { args: { mint: MINT }, path: `/v1/halts/${MINT}` },
  oc_get_print_feed: { args: { mint: MINT }, path: `/v1/feeds/${MINT}` },
  oc_get_series: { args: { series: MINT }, path: `/v1/series/${MINT}` },
  oc_get_settlement: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/settlement` },
  oc_get_proof_with_draws: { args: { cross: MINT }, path: `/v1/crosses/${MINT}/proof/draws` },
  oc_get_treasury_terms: { args: { treasury: MINT }, path: `/v1/treasuries/${MINT}/ext` },
  oc_list_treasury_proposals: { args: { treasury: MINT }, path: `/v1/treasuries/${MINT}/proposals` },
  oc_get_treasury_position: { args: { treasury: MINT, owner: MINT }, path: `/v1/treasuries/${MINT}/positions/${MINT}` },
  oc_list_treasury_grants: { args: { treasury: MINT }, path: `/v1/treasuries/${MINT}/grants` },
  oc_list_treasury_rounds: { args: { treasury: MINT }, path: `/v1/treasuries/${MINT}/rounds` },
};

describe('rules, treasury and settlement tools', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    it(`${name} is a read tool that calls ${c.path.replace(MINT, ':x')}`, () => {
      const t = tool(name);
      expect(t, `${name} is in the catalog`).toBeDefined();
      expect(t.kind).toBe('read');
      expect(t.request(c.args)).toEqual({ method: 'GET', path: c.path });
      expect(t.inputSchema).toMatchObject({ additionalProperties: false, required: Object.keys(c.args).filter((k) => !(name === 'oc_get_lockups' && k === 'cross')) });
    });
  }

  it('oc_get_lockups adds the cross filter only when given one', () => {
    expect(tool('oc_get_lockups').request({ owner: MINT, cross: MINT }).path).toBe(`/v1/owners/${MINT}/lockups?cross=${MINT}`);
  });

  it('the catalog lists every tool of the table above, once', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of Object.keys(NEW_TOOLS)) expect(names.filter((x) => x === n)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool of the catalog calls a route the API registers', () => {
    const dir = join(__dirname, '..', '..', 'api', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
      }
    };
    walk(dir);
    const routes = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\.(get|post)(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) routes.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    const matches = (method: string, path: string) =>
      [...routes].some((r) => {
        const [m, p] = r.split(' ') as [string, string];
        if (m !== method) return false;
        return new RegExp(`^${p.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path);
      });
    const sample = (schema: Record<string, unknown>): Record<string, unknown> => {
      const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; pattern?: string }>;
      const out: Record<string, unknown> = {};
      for (const k of (schema.required ?? []) as string[]) {
        const p = props[k]!;
        out[k] = p.enum ? p.enum[0] : p.type === 'integer' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : p.type === 'object' ? {} : p.pattern?.includes('0-9') ? '1' : MINT;
      }
      return out;
    };
    const missing: string[] = [];
    for (const t of TOOLS) {
      let req;
      try {
        req = t.request(sample(t.inputSchema));
      } catch {
        continue;
      }
      if (!matches(req.method, req.path.split('?')[0]!)) missing.push(`${t.name}: ${req.method} ${req.path}`);
    }
    expect(missing).toEqual([]);
  });
});
