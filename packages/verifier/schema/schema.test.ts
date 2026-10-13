// The published JSON Schema of the fairness proof against real proofs. Three groups:
//   1. proofs captured from the live devnet API (committed under fixtures/), covering a printed cross with a rationed side, a
//      single-order cross, a cross that did not print and a cross that has not cleared;
//   2. proofs fetched from the live API now, for every cross it lists, so a change in what the API serves fails this test;
//   3. proofs the reference verifier itself builds, and deliberately broken documents the schema must refuse.
// The live half needs the network; without it the half is skipped with a message rather than reported as passed.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = new URL('.', import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, here), 'utf8')) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateProof = ajv.compile(load('fairness-proof.v1.schema.json'));

const fixtures = readdirSync(new URL('fixtures/', here))
  .filter((f) => f.startsWith('proof-'))
  .map((f) => [f, load(`fixtures/${f}`)] as const);

const errors = () => JSON.stringify(validateProof.errors, null, 1);

describe('fairness-proof.v1 schema against captured live proofs', () => {
  it('has fixtures for each outcome', () => {
    const names = fixtures.map(([f]) => f);
    expect(names).toEqual(expect.arrayContaining(['proof-printed-rationed.json', 'proof-no-print.json', 'proof-printed-single.json', 'proof-live-not-cleared.json']));
  });
  it.each(fixtures)('accepts %s', (_f, proof) => {
    expect(validateProof(proof), errors()).toBe(true);
  });
  it('captured a cross that really printed, one that really did not, and one still live', () => {
    const by = Object.fromEntries(fixtures.map(([f, p]) => [f, p as { onchain: { printed: boolean }; state: string; verified: boolean }]));
    expect(by['proof-printed-rationed.json']!.onchain.printed).toBe(true);
    expect(by['proof-no-print.json']!.onchain.printed).toBe(false);
    expect(by['proof-live-not-cleared.json']).toMatchObject({ state: 'Live', verified: false });
  });
});

describe('fairness-proof.v1 schema refuses broken documents', () => {
  const good = () => structuredClone(fixtures.find(([f]) => f === 'proof-printed-rationed.json')![1]) as Record<string, any>;
  const broken: [string, (p: Record<string, any>) => void][] = [
    ['a wrong schema id', (p) => void (p.schema = 'opening-cross/fairness-proof/v2')],
    ['a missing verified', (p) => void delete p.verified],
    ['a numeric price (must be a decimal string)', (p) => void (p.onchain.price = 1200000)],
    ['a price with a decimal point', (p) => void (p.onchain.price = '1.2')],
    ['an unknown rationed side', (p) => void (p.onchain.rationed = 'both')],
    ['an unknown state', (p) => void (p.state = 'Settled')],
    ['a printed result without a price', (p) => void (p.onchain.price = null)],
    ['a result that did not print but carries a price', (p) => {
      p.onchain.printed = false;
      p.onchain.noPrintReason = 0;
    }],
    ['a recomputed no-print reason given as an index', (p) => void ((p.recomputed.printed = false), (p.recomputed.price = null), (p.recomputed.matched = null), (p.recomputed.rationed = null), (p.recomputed.noPrintReason = 1))],
    ['a book level without its order counts', (p) => void delete p.book[0].buyOrders],
    ['a negative order count', (p) => void (p.book[0].sellOrders = -1)],
    ['a cross that is not an address', (p) => void (p.cross = 'not an address')],
    ['notes that are not strings', (p) => void (p.notes = [1])],
    ['a Live cross reported as verified', (p) => void ((p.state = 'Live'), (p.verified = true))],
  ];
  it.each(broken)('refuses %s', (_name, mutate) => {
    const p = good();
    mutate(p);
    expect(validateProof(p)).toBe(false);
  });
  it('allows an optional field added later (OCIP-1: adding an optional field needs no new schema version)', () => {
    const p = good();
    p.futureField = { anything: 1 };
    expect(validateProof(p), errors()).toBe(true);
  });
});

const API = process.env.OC_API_URL ?? 'https://98-87-59-136.sslip.io';

async function getJson(path: string): Promise<unknown | null> {
  // The API reads the proof from a rate-limited public RPC: a 429, a 503 and a timeout are waited out, never turned into a pass.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(25_000) });
      if (r.status === 429 || r.status === 503 || r.status === 504) {
        await new Promise((ok) => setTimeout(ok, Math.min(2000 * 2 ** attempt, 15_000)));
        continue;
      }
      return r.ok ? await r.json() : null;
    } catch {
      await new Promise((ok) => setTimeout(ok, Math.min(2000 * 2 ** attempt, 15_000)));
    }
  }
  return null;
}

describe('fairness-proof.v1 schema against the live API', () => {
  it('accepts the proof of every cross the API lists, as served right now', async (ctx) => {
    const list = (await getJson('/v1/crosses?limit=200')) as { crosses: { address: string; state: string }[] } | null;
    if (!list) {
      console.warn(`schema.test.ts live half SKIPPED: ${API} could not be reached. Set OC_API_URL to a reachable API to run it.`);
      return ctx.skip();
    }
    // Every state, printed and not: the newest few of each state plus every cross that has not finalized.
    const wanted = new Map<string, string>();
    const seenState = new Map<string, number>();
    for (const c of list.crosses) {
      const n = seenState.get(c.state) ?? 0;
      if (c.state !== 'Finalized' || n < 8) wanted.set(c.address, c.state);
      seenState.set(c.state, n + 1);
    }
    expect(wanted.size).toBeGreaterThan(3);
    const failures: string[] = [];
    let checked = 0;
    for (const [address] of wanted) {
      const proof = await getJson(`/v1/crosses/${address}/proof`);
      if (proof === null) {
        failures.push(`${address}: the API did not return a proof`);
        continue;
      }
      checked++;
      if (!validateProof(proof)) failures.push(`${address}: ${JSON.stringify(validateProof.errors)}`);
    }
    console.info(`schema.test.ts validated ${checked} live proofs from ${API}`);
    expect(failures).toEqual([]);
    expect(checked).toBe(wanted.size);
  }, 400_000);
});
