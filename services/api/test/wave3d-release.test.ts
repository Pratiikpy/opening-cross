// The release report for the seven Wave 3D programs (GET /v1/programs), the features a screen may offer, and the one place a program's absence changes the creation of a
// cross: the governed-graduation rule is refused while cross_graduate or the batch 2 gate is definitely not on the cluster. The programs' bytes are fabricated: a block of
// filler with the `lddw` that loads each instruction's discriminator, as the compiler emits it.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import { getMintEncoder } from '@solana-program/token-2022';
import { none, some } from '@solana/kit';
import { FLAG_GOVERNED_GRADUATION } from '@opening-cross/sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, OPEN_DBC_POOL_DISCRIMINATOR, OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR, SEED_FUTARCHY_DAO_DISCRIMINATOR } from '@opening-cross/cross-settle-client';
import { registerHolderPrograms } from '../src/routes/holder-programs.js';
import { registerRulesTx } from '../src/routes/rules-tx.js';
import { NEW_PROGRAMS, NEW_PROGRAM_KEYS, type NewProgramKey, governedGraduationState, programRelease } from '../src/routes/programs-support.js';
import { NEW_PROGRAM_INSTRUCTIONS } from '../src/routes/programs-catalog.js';
import { Chain, LOADER, NOW, SPL, T22, elf, key, ready, server } from './helpers/wave3d.js';
import { releaseGate } from '../src/routes/program-gate.js';

const dataAddress = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const programData = (body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(45 + body.length);
  new DataView(out.buffer).setUint32(0, 3, true);
  new DataView(out.buffer).setBigUint64(4, 4242n, true);
  out.set(body, 45);
  return out;
};
const programAccount = (data: Address) => {
  const out = new Uint8Array(36);
  new DataView(out.buffer).setUint32(0, 2, true);
  out.set(getAddressEncoder().encode(data), 4);
  return out;
};
const put = (chain: Chain, program: Address, data: Address, discs: Uint8Array[]) => {
  chain.put(program, LOADER, programAccount(data));
  chain.put(data, LOADER, programData(elf(discs)));
};
const allOf = (k: NewProgramKey) => NEW_PROGRAM_INSTRUCTIONS[k].map(([, d]) => d);

async function programs(chain: Chain) {
  const app = Fastify();
  registerHolderPrograms(app, { account: chain.account, network: 'devnet', clock: () => NOW });
  const res = await app.inject({ method: 'GET', url: '/v1/programs' });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('GET /v1/programs: the seven Wave 3D programs', () => {
  it('reports every program as not deployed, and every feature as unavailable, on a cluster that has none of them', async () => {
    const { status, body } = await programs(new Chain());
    expect(status).toBe(200);
    for (const k of NEW_PROGRAM_KEYS) {
      expect(body.programs[k], k).toMatchObject({ address: NEW_PROGRAMS[k].address, name: NEW_PROGRAMS[k].name, deployed: false, extended: false, deployedSlot: null, checked: [] });
      expect(body.programs[k].note, k).toMatch(/not deployed.*H27.*PROGRAM_NOT_DEPLOYED/);
    }
    for (const f of ['mandates', 'conviction', 'baskets', 'listing', 'bounty', 'backing', 'governedGraduation', 'fixedPricePresale', 'futarchyDao']) expect(body.features[f].available, f).toBe(false);
    expect(body.features.governedGraduation.unverified[0]).toMatch(/rule flag 32/);
    expect(body.features.mandates.note).toMatch(/cross_mandate, which is not deployed/);
  });

  it('reports a program with every instruction as deployed, and one without some as not', async () => {
    const chain = new Chain();
    put(chain, NEW_PROGRAMS.crossMandate.address, dataAddress(201), allOf('crossMandate'));
    put(chain, NEW_PROGRAMS.crossBasket.address, dataAddress(202), allOf('crossBasket').slice(0, 2));
    const { body } = await programs(chain);
    expect(body.programs.crossMandate).toMatchObject({ deployed: true, extended: true, deployedSlot: '4242' });
    expect(body.programs.crossMandate.checked).toHaveLength(10);
    expect(body.programs.crossBasket.deployed).toBe(false);
    expect(body.programs.crossBasket.note).toMatch(/without redeem_shares/);
    expect(body.programs.crossBasket.checked.map((c: { present: boolean }) => c.present)).toEqual([true, true, false]);
    expect(body.features.mandates).toMatchObject({ available: true });
    expect(body.features.baskets.available).toBe(false);
    expect(body.programs.crossBounty.deployed).toBe(false);
  });

  it('never calls a program it could not read a missing one: unknown, and asked again next time', async () => {
    const chain = new Chain();
    let fail = true;
    const app = Fastify();
    registerHolderPrograms(app, {
      account: async (a) => {
        if (fail) throw new Error('429');
        return chain.account(a);
      },
      clock: () => NOW,
    });
    const first = JSON.parse((await app.inject({ method: 'GET', url: '/v1/programs' })).body);
    for (const k of NEW_PROGRAM_KEYS) expect(first.programs[k], k).toMatchObject({ deployed: null, extended: null });
    for (const f of Object.values(first.features) as { available: boolean | null }[]) expect(f.available).toBeNull();
    fail = false;
    const second = JSON.parse((await app.inject({ method: 'GET', url: '/v1/programs' })).body);
    expect(second.programs.crossMandate.deployed).toBe(false);
  });

  it('does not trust a scan that cannot find the control instruction', async () => {
    const chain = new Chain();
    put(chain, NEW_PROGRAMS.crossBounty.address, dataAddress(203), []); // no create_bounty in the bytes
    const { body } = await programs(chain);
    expect(body.programs.crossBounty).toMatchObject({ deployed: null, extended: null, deployedSlot: '4242' });
    expect(body.programs.crossBounty.note).toMatch(/could not find create_bounty.*not trusted/);
  });

  it('makes governed graduation available only when cross_graduate and the batch 2 gate are both there, and the presale and DAO adapters only with batch 2', async () => {
    const chain = new Chain();
    put(chain, NEW_PROGRAMS.crossGraduate.address, dataAddress(204), allOf('crossGraduate'));
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(205), [OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array]);
    let b = (await programs(chain)).body;
    expect(b.features.governedGraduation.available).toBe(false);
    expect(b.features.futarchyDao.available).toBe(false);
    expect(b.features.fixedPricePresale.available).toBe(false);
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(205), [OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array]);
    b = (await programs(chain)).body;
    expect(b.features.governedGraduation.available).toBe(true);
    expect(b.features.futarchyDao.available).toBe(true);
    expect(b.features.fixedPricePresale.available).toBe(false);
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(205), [OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array, OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR as Uint8Array]);
    expect((await programs(chain)).body.features.fixedPricePresale.available).toBe(true);
  });
});

describe('the release check of the routes', () => {
  it('finds a program missing at once, caches the answer for twenty seconds only, and keeps a found instruction for the time to live', async () => {
    const chain = new Chain();
    let t = NOW;
    const gate = programRelease({ account: chain.account, clock: () => t });
    expect(await gate('crossMandate')).toBe('program-missing');
    const reads = chain.reads;
    expect(await gate('crossMandate')).toBe('program-missing');
    expect(chain.reads).toBe(reads); // kept
    chain.deploy('crossMandate');
    expect(await gate('crossMandate')).toBe('program-missing'); // still kept
    t += 21;
    expect(await gate('crossMandate')).toBe('ready'); // asked again: the program has been deployed
    const after = chain.reads;
    t += 400;
    expect(await gate('crossMandate')).toBe('ready');
    expect(chain.reads).toBe(after); // a found program is kept for ten minutes
    expect(await gate('crossMandate', { name: 'revoke', discriminator: allOf('crossMandate')[3]! })).toBe('instruction-missing');
  });
});

describe('creating a cross with the governed-graduation rule', () => {
  async function app(opts: { gate: Parameters<typeof registerRulesTx>[1]['gate']; settleGate: Parameters<typeof registerRulesTx>[1]['settleGate'] }) {
    const [creator, base, quote, integrator] = await Promise.all([key(), key(), key(), key()]);
    const chain = new Chain();
    const mint = (authority: Address | null) => new Uint8Array(getMintEncoder().encode({ mintAuthority: authority ? some(authority) : none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));
    chain.put(base, T22, mint(creator));
    chain.put(quote, SPL, mint(creator));
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(207), []); // present on the cluster; whether it has the gate is the injected check's answer
    const s = server();
    registerRulesTx(s, { account: chain.account, lifetime: chain.lifetime, network: 'devnet', clock: () => NOW, ...opts });
    const body = (rules: Record<string, unknown>) => ({
      creator, baseMint: base, quoteMint: quote, baseTokenProgram: T22, quoteTokenProgram: SPL, crossId: '77', kind: 'launch', supplyMode: 'mint', disclosure: 'open', minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000',
      openTs: String(NOW + 100), closeTs: String(NOW + 1_100), revealEndTs: String(NOW + 1_200), integrator, shards: 2, maxOrders: 64, proceedsTo: creator, schedule: [{ price: '1000000', quantity: '100000000' }], rules,
    });
    const post = async (url: string, payload: unknown) => {
      const r = await s.inject({ method: 'POST', url, payload: payload as never });
      return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
    };
    return { post, body };
  }
  const settle = (state: 'present' | 'absent' | 'unknown') => async () => state;

  it('is refused with PROGRAM_NOT_DEPLOYED, naming what is missing, while cross_graduate or the gate is definitely absent', async () => {
    for (const [gate, settleState, missing] of [
      [async () => 'program-missing' as const, 'present' as const, /cross_graduate is not deployed/],
      [ready, 'absent' as const, /batch 2/],
    ] as const) {
      const a = await app({ gate, settleGate: settle(settleState) });
      const r = await a.post('/v1/tx/create-cross-ruled', a.body({ flags: FLAG_GOVERNED_GRADUATION }));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: 'PROGRAM_NOT_DEPLOYED', feature: 'governedGraduation' });
      expect(r.body.error).toMatch(/could not open a pool/);
      expect(r.body.missing.join(' ')).toMatch(missing);
    }
  });

  it('is built when both are there, and built with a warning when the release cannot be read; other rules are untouched either way', async () => {
    const both = await app({ gate: ready, settleGate: settle('present') });
    const ok = await both.post('/v1/tx/create-cross-ruled', both.body({ flags: FLAG_GOVERNED_GRADUATION }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.warnings.map((w: { code: string }) => w.code)).not.toContain('GOVERNED_UNVERIFIED');
    const unknown = await app({ gate: async () => 'unknown', settleGate: settle('present') });
    const warned = await unknown.post('/v1/tx/create-cross-ruled', unknown.body({ flags: FLAG_GOVERNED_GRADUATION }));
    expect(warned.status).toBe(200);
    expect(warned.body.warnings.map((w: { code: string }) => w.code)).toContain('GOVERNED_UNVERIFIED');
    const absent = await app({ gate: async () => 'program-missing', settleGate: settle('absent') });
    expect((await absent.post('/v1/tx/create-cross-ruled', absent.body({ guards: { minRaiseQuote: '1000000' } }))).status).toBe(200);
    expect((await absent.post('/v1/rules/check', absent.body({ flags: FLAG_GOVERNED_GRADUATION }))).body).toEqual({ ok: true, issues: [] });
  });

  it('governedGraduationState reports ready only when both are found, false when one is definitely missing, null when it cannot tell', async () => {
    const chain = new Chain();
    const real = releaseGate({ account: chain.account, clock: () => NOW });
    const g = (graduate: 'ready' | 'program-missing' | 'unknown') => governedGraduationState({ account: chain.account, gate: async () => graduate, settleGate: real });
    expect(await g('ready')).toEqual({ ready: false, missing: ['cross_settle is not deployed'] }); // cross_settle is not on this chain: the gate cannot be there
    expect((await g('program-missing')).missing).toEqual(expect.arrayContaining(['cross_graduate is not deployed']));
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(206), [OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array]);
    expect((await governedGraduationState({ account: chain.account, gate: ready, settleGate: releaseGate({ account: chain.account, clock: () => NOW }) })).ready).toBe(false);
    put(chain, CROSS_SETTLE_PROGRAM_ADDRESS, dataAddress(206), [OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array]);
    expect(await governedGraduationState({ account: chain.account, gate: ready, settleGate: releaseGate({ account: chain.account, clock: () => NOW }) })).toEqual({ ready: true, missing: [] });
    expect((await governedGraduationState({ account: chain.account, gate: async () => 'unknown', settleGate: releaseGate({ account: chain.account, clock: () => NOW }) })).ready).toBeNull();
  });
});
