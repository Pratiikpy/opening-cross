// The deploy configuration read as the deployment reads it (rows Z4 and Y7, and the keeper's own variables). `deploy/docker-compose.yml` is parsed, its `${VAR:-default}`
// substitutions are expanded the way docker compose expands them, and the result is handed to the code that consumes it: the API's own parser and external-flow function
// for OWN_WALLETS, and the keeper's own configuration reader for the KEEPER_* variables. Nothing here is a copy of the logic under test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { address as toAddress } from '@solana/kit';
import { type CrossFact, externalFlow, parseOwnWallets } from '../../api/src/metrics.js';
import { DEFAULT_DUTIES, keeperConfig } from '../src/index.js';

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(root('deploy/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');
const envExample = readFileSync(root('deploy/.env.example'), 'utf8').replace(/\r\n/g, '\n');

/** The `environment:` entries of one service: `KEY: value` lines two levels under it. Merge keys (`<<: *env`) and comments are not entries. */
function serviceEnv(service: string): Record<string, string> {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`no service ${service} in the compose file`);
  const out: Record<string, string> = {};
  let inEnv = false;
  for (const l of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break; // the next service, or the end of `services`
    if (/^ {4}environment:/.test(l)) inEnv = true;
    else if (/^ {4}\S/.test(l)) inEnv = false;
    const m = inEnv ? /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(l) : null;
    if (m) out[m[1]!] = m[2]!.trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** docker compose's substitution: `${V}`, `${V:-d}` (unset or empty), `${V-d}` (unset), `${V:?msg}` (unset or empty is an error). */
function expand(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?:(:?[-?])([^}]*))?\}/g, (_m, name: string, op: string | undefined, arg: string | undefined) => {
    const v = env[name];
    const blank = op?.startsWith(':') ? v === undefined || v === '' : v === undefined;
    if (op?.endsWith('?') && blank) throw new Error(`${name}: ${arg}`);
    if (op?.endsWith('-') && blank) return arg ?? '';
    return v ?? '';
  });
}
const expandAll = (vars: Record<string, string>, env: Record<string, string>) => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, expand(v, env)]));

const OWN_KEEPER = '3JqaMApyG6xYqkH1m3Q1gJbT3b2oDcb7b5mYh1yTfDXn';

describe('OWN_WALLETS reaches the API (rows Z4, Y7)', () => {
  const api = serviceEnv('api');

  it('is passed through by compose, from the same variable, and empty when unset', () => {
    expect(api.OWN_WALLETS).toBe('${OWN_WALLETS:-}');
    expect(expand(api.OWN_WALLETS!, {})).toBe('');
    expect(expand(api.OWN_WALLETS!, { OWN_WALLETS: 'a,b' })).toBe('a,b');
  });

  it('is documented in .env.example with its empty default', () => {
    expect(envExample).toMatch(/^OWN_WALLETS=$/m);
  });

  it('is read by the API under that name (services/api/src/main.ts)', () => {
    expect(readFileSync(root('services/api/src/main.ts'), 'utf8')).toMatch(/parseOwnWallets\(process\.env\.OWN_WALLETS, isAddress\)/);
  });

  it('the value compose hands over is accepted by the API\'s parser as a list, or an empty set; a value that is not an address is refused', () => {
    const [keeper, mm, team] = [OWN_KEEPER, 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC', 'HjSYwwj6byv2KbUGHucjxhs1UJWPmzud6fRkB5GZRa8k'];
    const isAddr = (s: string) => {
      try {
        toAddress(s);
        return true;
      } catch {
        return false;
      }
    };
    const handed = expand(api.OWN_WALLETS!, { OWN_WALLETS: `${keeper}, ${mm}\n${team}` });
    expect([...parseOwnWallets(handed, isAddr)]).toEqual([keeper, mm, team]);
    expect(parseOwnWallets(expand(api.OWN_WALLETS!, {}), isAddr).size).toBe(0);
    expect(() => parseOwnWallets(expand(api.OWN_WALLETS!, { OWN_WALLETS: `${keeper},not-an-address` }), isAddr)).toThrow(/not a Solana address/);
  });

  // One cross with orders from the operator's keeper wallet, its market maker, and two outside wallets, one of which also trades as the cross's creator elsewhere.
  const statics = (creator: string) => ({ priceScale: 1_000_000n, quoteDecimals: 6, baseDecimals: 6, creator, proceedsTo: creator, integrator: creator, feeRecipient: creator, gateMint: null, sealed: false });
  const order = (owner: string, fill: bigint | null) => ({ owner, side: 'buy' as const, escrow: 1n, price: 1n, quantity: 1n, status: 'claimed', fill, quoteOut: null });
  const MM = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
  const OUTSIDER = 'HjSYwwj6byv2KbUGHucjxhs1UJWPmzud6fRkB5GZRa8k';
  const OUTSIDER2 = 'GZZ54f6pWw3oYd3g1AqzR5QFvM7pQp2xYhV6mZkq3sBt';
  const ISSUER = 'Fc3pGwJ5k1o7sRjH8yTn9a4UuXb2VwQe6LdZ5mC1rPtY';
  const cross = (address: string): CrossFact => ({
    address, state: 'Finalized', closeTs: 1, clearingPrice: 1n, matched: 1n, clearedAt: 1, finalizedAt: 2, statics: statics(ISSUER),
    orders: [order(OWN_KEEPER, 5n), order(MM, 5n), order(OUTSIDER, 5n), order(OUTSIDER2, null)],
  });

  it('what compose passes is what keeps the keeper\'s and the market maker\'s flow out of the external figures; unset, they are counted as outside users', () => {
    const isAddr = () => true;
    const withList = parseOwnWallets(expand(api.OWN_WALLETS!, { OWN_WALLETS: `${OWN_KEEPER},${MM}` }), isAddr);
    const configured = externalFlow([cross('C1')], withList, 'devnet');
    expect(configured.ownWalletsConfigured).toBe(2);
    expect(configured.wallets).toMatchObject({ total: 4, own: 2, external: 2 });
    expect(configured.filledWallets).toEqual({ total: 3, own: 2, external: 1 }); // only OUTSIDER was filled among the outsiders
    expect(configured.orders).toMatchObject({ total: 4, byExternal: 2, filled: 3, filledByExternal: 1 });
    expect(configured.verdict).toMatch(/not known to be ours/);

    const unset = externalFlow([cross('C1')], parseOwnWallets(expand(api.OWN_WALLETS!, {}), isAddr), 'devnet');
    expect(unset.ownWalletsConfigured).toBe(0);
    expect(unset.wallets).toMatchObject({ total: 4, own: 0, external: 4 });
    expect(unset.filledWallets.external).toBe(3);
    expect(unset.verdict).toMatch(/ownership list not configured \(upper bound\)/);
  });

  it('a wallet that is ours on one cross and a user on another is external overall: the list is not an allow-all', () => {
    const other = { ...cross('C2'), statics: statics(OUTSIDER) }; // OUTSIDER is the creator of C2 (own there), a bidder in C1 (external there)
    const f = externalFlow([cross('C1'), other], new Set([OWN_KEEPER, MM]), 'devnet');
    expect(f.wallets.external).toBeGreaterThanOrEqual(2);
    expect(f.wallets.own + f.wallets.external).toBe(f.wallets.total);
  });
});

describe('the keeper\'s variables', () => {
  const keeper = serviceEnv('keeper');

  it('compose refuses to start the keeper without KEEPER_CREATORS: an empty scope would serve every cross on the cluster', () => {
    expect(keeper.KEEPER_CREATORS).toMatch(/^\$\{KEEPER_CREATORS:\?/);
    expect(() => expandAll(keeper, {})).toThrow(/KEEPER_CREATORS/);
    expect(() => expandAll(keeper, { KEEPER_CREATORS: '' })).toThrow(/KEEPER_CREATORS/);
  });

  it('every KEEPER_* variable the process reads is passed by compose, and every one compose passes is read', () => {
    // The names that appear in code; comment lines are left out, because the header of main.ts documents every one of them.
    const code = ['src/main.ts', 'src/config.ts'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
    const src = code.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const read = new Set([...src.matchAll(/\b(KEEPER_[A-Z_]+)\b/g)].map((m) => m[1]!));
    // PASS_MS reaches the process as KEEPER_PASS_MS -> PASS_MS in compose; the process reads PASS_MS.
    const passed = new Set(Object.keys(keeper).filter((k) => k.startsWith('KEEPER_')));
    for (const name of read) expect(passed, `${name} is read by the keeper but not passed by compose`).toContain(name);
    for (const name of passed) expect(read, `${name} is passed by compose but never read`).toContain(name);
    expect(keeper.PASS_MS).toBe('${KEEPER_PASS_MS:-15000}');
  });

  it('with only the required variable set, compose hands the process the defaults: the default duties, one-hour partner-fee interval, no billing, no exemptions', () => {
    const env = expandAll(keeper, { KEEPER_CREATORS: OWN_KEEPER });
    const cfg = keeperConfig(env);
    expect([...cfg.duties].sort()).toEqual([...DEFAULT_DUTIES].sort());
    expect(cfg).toMatchObject({ passMs: 15_000, creators: [OWN_KEEPER], dryRun: false, minRelease: 1n, billingUrl: null });
    expect(cfg.partnerFees).toEqual({ everySecs: 3_600, minQuote: 1n, minBase: 1n });
    expect(cfg.entitlementExempt.size + cfg.breakerFeeds.size).toBe(0);
  });

  it('the duties an operator names in .env are the duties the keeper does, partner-fees included', () => {
    const env = expandAll(keeper, { KEEPER_CREATORS: OWN_KEEPER, KEEPER_DUTIES: 'default,locks,partner-fees', KEEPER_PARTNER_FEE_EVERY_SECS: '600', KEEPER_MIN_PARTNER_QUOTE: '25000', KEEPER_BILLING_URL: 'http://billing:8791', KEEPER_ENTITLEMENT_EXEMPT: `${OWN_KEEPER}, ${OWN_KEEPER}` });
    const cfg = keeperConfig(env);
    expect(cfg.duties.has('partner-fees') && cfg.duties.has('locks') && cfg.duties.has('refunds')).toBe(true);
    expect(cfg.partnerFees).toEqual({ everySecs: 600, minQuote: 25_000n, minBase: 1n });
    expect(cfg.billingUrl).toBe('http://billing:8791');
    expect([...cfg.entitlementExempt]).toEqual([OWN_KEEPER]);
  });

  it('a blank KEEPER_DUTIES is the default, not "none"; the word none is how to turn every optional duty off', () => {
    expect(keeperConfig({ KEEPER_DUTIES: '' }).duties).toEqual(new Set(DEFAULT_DUTIES));
    expect(keeperConfig({ KEEPER_DUTIES: '   ' }).duties).toEqual(new Set(DEFAULT_DUTIES));
    expect(keeperConfig({ KEEPER_DUTIES: 'none' }).duties.size).toBe(0);
  });

  it('refuses what is not a duty, a number, or a URL, naming the variable', () => {
    expect(() => keeperConfig({ KEEPER_DUTIES: 'partner_fees' })).toThrow(/unknown keeper duty/);
    expect(() => keeperConfig({ KEEPER_PARTNER_FEE_EVERY_SECS: 'hourly' })).toThrow(/KEEPER_PARTNER_FEE_EVERY_SECS/);
    expect(() => keeperConfig({ KEEPER_PARTNER_FEE_EVERY_SECS: '0' })).toThrow(/at least 1/);
    expect(() => keeperConfig({ KEEPER_MIN_PARTNER_QUOTE: '-5' })).toThrow(/KEEPER_MIN_PARTNER_QUOTE/);
    expect(() => keeperConfig({ KEEPER_MIN_RELEASE: '1.5' })).toThrow(/KEEPER_MIN_RELEASE/);
    expect(() => keeperConfig({ PASS_MS: 'fast' })).toThrow(/PASS_MS/);
    expect(() => keeperConfig({ KEEPER_BILLING_URL: 'billing:8791' })).toThrow(/KEEPER_BILLING_URL/);
  });

  it('every KEEPER_* variable compose passes is documented in .env.example', () => {
    // The operator-facing ones: those whose value is a `${...}` placeholder (KEEPER_KEYPAIR is a path inside the container that compose fixes).
    for (const [name, value] of Object.entries(keeper).filter(([k, v]) => k.startsWith('KEEPER_') && v.includes('${'))) expect(envExample, `${name} is not in .env.example`).toMatch(new RegExp(`^${name}=`, 'm'));
  });
});
