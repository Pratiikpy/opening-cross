// Gate routes over HTTP with accounts injected in memory: discovery, eligibility diagnostics, allowlist publication and the claim-pass builder.
import { beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { type Address, generateKeyPairSigner, getAddressEncoder, none, some } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, getCrossDecoder, getCrossEncoder, gatePassAddress } from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS, Mode, findConfigPda, getGateConfigEncoder, getPassEncoder } from '@opening-cross/cross-gate-client';
import { buildAllowlist } from '@opening-cross/presets/gate-allowlist';
import { RequestError } from '../src/tx.js';
import { type AllowlistStore, attestationAddress, readAttestation, registerGate } from '../src/routes/gate.js';

const SAS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
const NOW = 1_800_000_000;
const enc = getAddressEncoder();
const kp = async () => (await generateKeyPairSigner()).address;

function attestationBytes(nonce: Address, credential: Address, schema: Address, expiry: bigint, data = new Uint8Array([1])) {
  const out = new Uint8Array(1 + 96 + 4 + data.length + 32 + 8 + 32);
  const dv = new DataView(out.buffer);
  out[0] = 2;
  out.set(enc.encode(nonce), 1);
  out.set(enc.encode(credential), 33);
  out.set(enc.encode(schema), 65);
  dv.setUint32(97, data.length, true);
  out.set(data, 101);
  dv.setBigInt64(101 + data.length + 32, expiry, true);
  return out;
}

describe('readAttestation', () => {
  it('reads liveness exactly as the program does', async () => {
    const [w, c, s, other] = await Promise.all([kp(), kp(), kp(), kp()]);
    const acct = (bytes: Uint8Array, owner = SAS) => ({ data: bytes, owner });
    expect(readAttestation(null, c, s, w, 10n)).toEqual({ state: 'missing' });
    expect(readAttestation(acct(attestationBytes(w, c, s, 0n)), c, s, w, 10n)).toEqual({ state: 'live', expiry: 0n });
    expect(readAttestation(acct(attestationBytes(w, c, s, 11n)), c, s, w, 10n)).toEqual({ state: 'live', expiry: 11n });
    expect(readAttestation(acct(attestationBytes(w, c, s, 10n)), c, s, w, 10n)).toEqual({ state: 'expired', expiry: 10n });
    expect(readAttestation(acct(attestationBytes(w, c, s, 0n, new Uint8Array(40))), c, s, w, 10n)).toMatchObject({ state: 'live' });
    expect(readAttestation(acct(attestationBytes(other, c, s, 0n)), c, s, w, 10n)).toEqual({ state: 'foreign' });
    expect(readAttestation(acct(attestationBytes(w, other, s, 0n)), c, s, w, 10n)).toEqual({ state: 'foreign' });
    expect(readAttestation(acct(attestationBytes(w, c, other, 0n)), c, s, w, 10n)).toEqual({ state: 'foreign' });
    expect(readAttestation(acct(attestationBytes(w, c, s, 0n), CROSS_GATE_PROGRAM_ADDRESS), c, s, w, 10n)).toEqual({ state: 'foreign' });
    expect(readAttestation(acct(new Uint8Array(0)), c, s, w, 10n)).toEqual({ state: 'missing' });
    expect(readAttestation(acct(new Uint8Array([2, 1, 2, 3])), c, s, w, 10n)).toEqual({ state: 'foreign' });
  });
});

describe('gate routes', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const published = new Map<string, { rootHex: string; addresses: Address[] }>();
  const store: AllowlistStore = { get: async (m) => published.get(m) ?? null, put: async (m, rootHex, addresses) => void published.set(m, { rootHex, addresses }) };
  const crossRows: { address: string }[] = [];
  let app: ReturnType<typeof Fastify>;
  let authority: Address;
  let credential: Address;
  let schema: Address;
  let alice: Address, bob: Address, carol: Address, dave: Address, erin: Address;
  let allowMint: Address, sasMint: Address, grantMint: Address, ghostMint: Address;
  let allowCross: Address, sasCross: Address, grantCross: Address, ghostCross: Address, openCross: Address;
  let tree: ReturnType<typeof buildAllowlist>;

  const putConfig = async (mint: Address, o: { root?: Uint8Array; sas?: boolean }) => {
    const [address, bump] = await findConfigPda({ mint });
    accounts.set(address, {
      owner: CROSS_GATE_PROGRAM_ADDRESS,
      data: new Uint8Array(getGateConfigEncoder().encode({ mint, authority, mode: Mode.Allowlist, bump, sas: o.sas ? some({ credential, schema }) : none(), allowlistRoot: o.root ? some(o.root) : none() })),
    });
  };
  const putPass = async (mint: Address, owner: Address) => {
    accounts.set(await gatePassAddress(mint, owner), { owner: CROSS_GATE_PROGRAM_ADDRESS, data: new Uint8Array(getPassEncoder().encode({ mint, owner, bump: 255 })) });
  };
  const putCross = async (gateMint: Address | null, state: CrossState = CrossState.Live) => {
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const base = getCrossDecoder().decode(z);
    const a = await kp();
    accounts.set(a, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getCrossEncoder().encode({ ...base, state, gateMint: gateMint ? some(gateMint) : none() } as never)) });
    crossRows.push({ address: a });
    return a;
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const codes = (b: { reasons: { code: string }[] }) => b.reasons.map((r) => r.code);

  beforeAll(async () => {
    [authority, credential, schema, alice, bob, carol, dave, erin] = await Promise.all(Array.from({ length: 8 }, kp));
    [allowMint, sasMint, grantMint, ghostMint] = await Promise.all(Array.from({ length: 4 }, kp));
    tree = buildAllowlist(allowMint, [alice, bob]);
    await putConfig(allowMint, { root: tree.root });
    await putConfig(sasMint, { sas: true });
    await putConfig(grantMint, {});
    // ghostMint: a cross names it but no config exists.
    allowCross = await putCross(allowMint);
    sasCross = await putCross(sasMint);
    grantCross = await putCross(grantMint);
    ghostCross = await putCross(ghostMint);
    openCross = await putCross(null);
    // SAS wallets: alice live, bob expired, carol none; dave has a live attestation AND a pass; erin a pass whose attestation lapsed.
    accounts.set(await attestationAddress(credential, schema, alice), { owner: SAS, data: attestationBytes(alice, credential, schema, 0n) });
    accounts.set(await attestationAddress(credential, schema, bob), { owner: SAS, data: attestationBytes(bob, credential, schema, BigInt(NOW - 5)) });
    accounts.set(await attestationAddress(credential, schema, dave), { owner: SAS, data: attestationBytes(dave, credential, schema, BigInt(NOW + 1000)) });
    await putPass(sasMint, dave);
    await putPass(sasMint, erin);
    await putPass(allowMint, bob);

    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
      return reply.code(500).send({ error: String(err) });
    });
    registerGate(app, {
      db: { query: async () => ({ rows: crossRows }) } as unknown as pg.Pool,
      account: async (a) => accounts.get(a) ?? null,
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
      clock: () => NOW,
      allowlists: store,
    });
    await app.ready();
  });

  it('lists the three presets without any jurisdiction rule', async () => {
    const { status, body } = await get('/v1/gates/presets');
    expect(status).toBe(200);
    expect(body.presets.map((p: { id: string }) => p.id)).toEqual(['open', 'allowlist', 'attested-wallet']);
    expect(JSON.stringify(body.presets)).not.toMatch(/countr|jurisdiction/i);
  });

  it('discovers the gates on recent crosses, each with its requirement and routes', async () => {
    const { status, body } = await get('/v1/gates');
    expect(status).toBe(200);
    const byMint = Object.fromEntries(body.gates.map((g: { mint: string }) => [g.mint, g]));
    expect(Object.keys(byMint).sort()).toEqual([allowMint, sasMint, grantMint, ghostMint].sort());
    expect(byMint[allowMint]).toMatchObject({ mode: 'Allowlist', allowlistRoot: tree.rootHex, sas: null, crosses: [allowCross] });
    expect(byMint[sasMint]).toMatchObject({ allowlistRoot: null, sas: { credential, schema } });
    expect(byMint[sasMint].routes.map((r: { kind: string }) => r.kind)).toEqual(['attestation', 'authority']);
    expect(byMint[grantMint].routes.map((r: { kind: string }) => r.kind)).toEqual(['authority']);
    expect(byMint[ghostMint]).toMatchObject({ config: null });
  });

  it('a cross with no gate: eligible, nothing to claim', async () => {
    const { body } = await get(`/v1/eligibility/${openCross}/${carol}`);
    expect(body).toMatchObject({ gated: false, eligible: true, canClaim: false });
    expect(codes(body)).toEqual(['CROSS_HAS_NO_GATE']);
  });

  it('a cross naming a gate with no config: nobody can pass, and it says why', async () => {
    const { body } = await get(`/v1/eligibility/${ghostCross}/${alice}`);
    expect(body).toMatchObject({ gated: true, eligible: false, canClaim: false });
    expect(codes(body)).toEqual(['GATE_CONFIG_MISSING']);
  });

  it('allowlist gate before the list is published: the wallet is told the proof cannot be built', async () => {
    const { body } = await get(`/v1/eligibility/${allowCross}/${alice}`);
    expect(body).toMatchObject({ eligible: false, canClaim: false, allowlist: { configured: true, published: false, listed: null } });
    expect(codes(body)).toEqual(['ALLOWLIST_NOT_PUBLISHED']);
    expect((await post('/v1/tx/claim-pass', { mint: allowMint, owner: alice })).status).toBe(422);
  });

  it('refuses to publish a list that does not hash to the root on chain, and accepts the one that does', async () => {
    const wrong = await post(`/v1/gates/${allowMint}/allowlist`, { addresses: [alice, bob, carol] });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ chainRoot: tree.rootHex });
    expect(published.size).toBe(0);
    expect((await post(`/v1/gates/${allowMint}/allowlist`, { addresses: [alice, 'nope'] })).status).toBe(400);
    expect((await post(`/v1/gates/${grantMint}/allowlist`, { addresses: [alice] })).status).toBe(409);
    const ok = await post(`/v1/gates/${allowMint}/allowlist`, { addresses: `${bob}\n${alice}` });
    expect(ok).toMatchObject({ status: 200, body: { published: true, count: 2, root: tree.rootHex } });
  });

  it('a wallet not on the published list is told so and who can change that', async () => {
    const { body } = await get(`/v1/eligibility/${allowCross}/${carol}`);
    expect(body).toMatchObject({ eligible: false, canClaim: false, allowlist: { published: true, listed: false } });
    expect(codes(body)).toEqual(['NOT_ON_ALLOWLIST']);
    expect(body.reasons[0].fix).toMatch(/Only the issuer/);
    expect((await post('/v1/tx/claim-pass', { mint: allowMint, owner: carol })).body.reasons[0].code).toBe('NOT_ON_ALLOWLIST');
  });

  it('a listed wallet can claim: the builder returns an unsigned cross_gate transaction paid by the wallet', async () => {
    const { body } = await get(`/v1/eligibility/${allowCross}/${alice}`);
    expect(body).toMatchObject({ eligible: false, canClaim: true, claim: { route: 'allowlist' } });
    expect(codes(body)).toEqual(['CLAIMABLE_BY_ALLOWLIST']);
    const tx = await post('/v1/tx/claim-pass', { mint: allowMint, owner: alice });
    expect(tx.status).toBe(200);
    expect(tx.body).toMatchObject({ route: 'allowlist', signers: [alice], pass: await gatePassAddress(allowMint, alice) });
    const raw = Buffer.from(tx.body.transaction, 'base64');
    expect(raw.includes(Buffer.from(enc.encode(CROSS_GATE_PROGRAM_ADDRESS)))).toBe(true);
    // A different payer pays and signs; the wallet itself does not sign.
    const sponsored = await post('/v1/tx/claim-pass', { mint: allowMint, owner: alice, payer: authority });
    expect(sponsored.body.signers).toEqual([authority]);
  });

  it('a wallet that already holds a pass is eligible, and cannot claim twice', async () => {
    const { body } = await get(`/v1/eligibility/${allowCross}/${bob}`);
    expect(body).toMatchObject({ eligible: true, canClaim: false });
    expect(codes(body)).toEqual(['HAS_PASS']);
    expect((await post('/v1/tx/claim-pass', { mint: allowMint, owner: bob })).status).toBe(409);
  });

  it('attestation gate: live attestation can claim, expired and missing ones get the exact fix', async () => {
    const a = (await get(`/v1/eligibility/${sasCross}/${alice}`)).body;
    expect(a).toMatchObject({ eligible: false, canClaim: true, claim: { route: 'attestation' }, sas: { state: 'live' } });
    const tx = await post('/v1/tx/claim-pass', { mint: sasMint, owner: alice });
    expect(tx).toMatchObject({ status: 200, body: { route: 'attestation', attestation: await attestationAddress(credential, schema, alice) } });

    const b = (await get(`/v1/eligibility/${sasCross}/${bob}`)).body;
    expect(codes(b)).toEqual(['ATTESTATION_EXPIRED']);
    expect(b).toMatchObject({ eligible: false, canClaim: false });
    expect((await post('/v1/tx/claim-pass', { mint: sasMint, owner: bob })).status).toBe(422);

    const c = (await get(`/v1/eligibility/${sasCross}/${carol}`)).body;
    expect(codes(c)).toEqual(['NO_ATTESTATION']);
    expect(c.reasons[0].fix).toContain(credential);
    expect(c.reasons[0].fix).toContain(carol);
  });

  it('a pass backed by an attestation that has lapsed still admits the wallet and warns that anyone can revoke it', async () => {
    const live = (await get(`/v1/eligibility/${sasCross}/${dave}`)).body;
    expect(live).toMatchObject({ eligible: true });
    expect(codes(live)).toEqual(['HAS_PASS']);
    const lapsed = (await get(`/v1/eligibility/${sasCross}/${erin}`)).body;
    expect(lapsed).toMatchObject({ eligible: true });
    expect(codes(lapsed)).toEqual(['HAS_PASS', 'PASS_BACKING_LAPSED']);
  });

  it('a gate with neither allowlist nor attestation points at the authority', async () => {
    const { body } = await get(`/v1/eligibility/${grantCross}/${alice}`);
    expect(codes(body)).toEqual(['AUTHORITY_GRANT_ONLY']);
    expect(body.reasons[0].fix).toContain(authority);
    expect(body.canClaim).toBe(false);
  });

  it('computes a root for a pasted list and reports what it dropped', async () => {
    const r = await post('/v1/gates/allowlist-root', { mint: allowMint, addresses: [alice, bob, alice, 'x'] });
    expect(r).toMatchObject({ status: 200, body: { root: tree.rootHex, count: 2, duplicates: 1, invalidCount: 1 } });
    expect((await post('/v1/gates/allowlist-root', { mint: allowMint, addresses: ['x'] })).status).toBe(400);
    expect((await post('/v1/gates/allowlist-root', { mint: 'bad', addresses: [alice] })).status).toBe(400);
  });

  it('rejects junk input with a 400/404, never a 500', async () => {
    expect((await get(`/v1/eligibility/nope/${alice}`)).status).toBe(400);
    expect((await get(`/v1/eligibility/${allowCross}/nope`)).status).toBe(400);
    expect((await get(`/v1/eligibility/${await kp()}/${alice}`)).status).toBe(404);
    expect((await get(`/v1/eligibility/${allowMint}/${alice}`)).status).toBe(404); // an address that exists but is not a cross
    expect((await get(`/v1/gates/${await kp()}`)).status).toBe(404);
    expect((await get('/v1/gates?limit=0')).status).toBe(400);
    expect((await post('/v1/tx/claim-pass', { mint: allowMint })).status).toBe(400);
    expect((await post('/v1/tx/claim-pass', { mint: allowMint, owner: alice, route: 'pigeon' })).status).toBe(400);
    expect((await post('/v1/tx/claim-pass', null)).status).toBe(400);
    expect((await post('/v1/tx/claim-pass', { mint: await kp(), owner: alice })).status).toBe(404);
  });

  it('one gate with the wallet standing attached', async () => {
    const { body } = await get(`/v1/gates/${sasMint}?wallet=${alice}`);
    expect(body).toMatchObject({ mint: sasMint, standing: { hasPass: false, claim: { route: 'attestation' } } });
  });
});
