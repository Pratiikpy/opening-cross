// GET /v1/dashboard: sections are the answers of the routes they name; a failing or absent route is reported, never defaulted.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { type Address, getAddressEncoder, generateKeyPairSigner } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { programState, registerDashboard } from '../src/routes/dashboard.js';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

function upgradeable(programDataAddress: Address, slot: bigint, authority: Address | null) {
  const program = new Uint8Array(36);
  new DataView(program.buffer).setUint32(0, 2, true);
  program.set(getAddressEncoder().encode(programDataAddress), 4);
  const code = 100;
  const pd = new Uint8Array(45 + code);
  const v = new DataView(pd.buffer);
  v.setUint32(0, 3, true);
  v.setBigUint64(4, slot, true);
  if (authority) {
    pd[12] = 1;
    pd.set(getAddressEncoder().encode(authority), 13);
  }
  return { program, pd };
}

describe('dashboard', () => {
  it('reads the deployed state of an upgradeable program from chain', async () => {
    const pda = (await generateKeyPairSigner()).address;
    const auth = (await generateKeyPairSigner()).address;
    const { program, pd } = upgradeable(pda, 123_456n, auth);
    const chain = new Map<string, { data: Uint8Array; owner: Address }>([
      [CROSS_CORE_PROGRAM_ADDRESS, { data: program, owner: LOADER as Address }],
      [pda, { data: pd, owner: LOADER as Address }],
    ]);
    const read = async (a: Address) => chain.get(a) ?? null;
    expect(await programState(read, CROSS_CORE_PROGRAM_ADDRESS)).toMatchObject({ deployed: true, upgradeable: true, lastDeployedSlot: '123456', upgradeAuthority: auth, allocatedBytes: 100 });
    // Authority revoked.
    chain.set(pda, { data: upgradeable(pda, 7n, null).pd, owner: LOADER as Address });
    expect(await programState(read, CROSS_CORE_PROGRAM_ADDRESS)).toMatchObject({ upgradeAuthority: null, lastDeployedSlot: '7' });
    expect(await programState(read, (await generateKeyPairSigner()).address)).toMatchObject({ deployed: false });
    chain.set(CROSS_CORE_PROGRAM_ADDRESS, { data: new Uint8Array(40), owner: '11111111111111111111111111111111' as Address });
    expect(await programState(read, CROSS_CORE_PROGRAM_ADDRESS)).toMatchObject({ deployed: true, upgradeable: false });
  });

  it('shows each section with its source, reports a failed or absent route, and computes nothing itself', async () => {
    const app = Fastify();
    let statsCalls = 0;
    app.get('/v1/health', async () => ({ ok: true, indexedSlot: '9' }));
    app.get('/v1/stats', async () => ({ network: 'devnet', crosses_total: ++statsCalls }));
    app.get('/v1/metrics/execution', async (_q, r) => r.code(500).send({ error: 'rpc busy' }));
    app.get('/v1/metrics/fairness', async () => ({ crosses: 3, perCross: [{ big: 'list' }], medianBuySide: 0.4 }));
    app.get('/v1/fees/ledger', async () => ({ entries: [1, 2, 3], totals: { verified: {} }, method: 'long' }));
    // /v1/metrics/external-flow, /v1/accuracy, /v1/fees/schedule and the ratings route are not registered at all.
    registerDashboard(app, { account: async () => null, network: 'devnet', clock: () => 1_800_000_000 }, { ttlMs: 60_000 });
    await app.ready();
    const get = async () => (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
    const body = await get();
    expect(body).toMatchObject({ schema: 'opening-cross/dashboard/v1', network: 'devnet', generatedAt: '2027-01-15T08:00:00.000Z' });
    expect(body.sections.health).toEqual({ ok: true, source: '/v1/health', data: { ok: true, indexedSlot: '9' } });
    expect(body.sections.totals.data).toEqual({ network: 'devnet', crosses_total: 1 });
    expect(body.sections.execution).toEqual({ ok: false, source: '/v1/metrics/execution', error: 'answered HTTP 500: rpc busy' });
    expect(body.sections.fairness.data).toEqual({ crosses: 3, medianBuySide: 0.4 }); // the long per-cross list is left to its own route
    expect(body.sections.fees.data).toEqual({ totals: { verified: {} }, entries: 3 });
    expect(body.sections.externalFlow).toEqual({ ok: false, source: '/v1/metrics/external-flow', error: 'this route is not enabled on this deployment' });
    expect(body.sections.accuracy.ok).toBe(false);
    expect(body.sections.programs.data).toHaveLength(5);
    expect(body.sections.programs.data[0]).toMatchObject({ name: 'cross_core', deployed: false });
    expect(body.note).toMatch(/computed by the dashboard/);
    // A second request inside the lifetime is the same answer, not another round of reads.
    expect((await get()).sections.totals.data.crosses_total).toBe(1);
  });

  it('leaves out the sections it is told to', async () => {
    const app = Fastify();
    registerDashboard(app, { account: async () => null }, { skip: ['programs', 'execution', 'fairness', 'externalFlow', 'accuracy', 'fees', 'protocol', 'ratings', 'health'] });
    await app.ready();
    expect(Object.keys((await app.inject({ method: 'GET', url: '/v1/dashboard' })).json().sections)).toEqual(['totals']);
  });
});
