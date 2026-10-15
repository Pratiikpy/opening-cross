import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSigner, signBytes } from '@solana/kit';
import type { FastifyInstance } from 'fastify';
import { Attester } from '../src/attester.js';
import { DEFAULT_POLICY } from '../src/decision.js';
import { buildKycServer, type ServerOptions } from '../src/kyc-server.js';
import { MemoryStore, ScriptedProvider, SECRET, W1, W2, active } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(() => app?.close());

async function make(o: ServerOptions = {}) {
  const provider = new ScriptedProvider();
  const store = new MemoryStore();
  const attester = new Attester({ provider, sas: store, policy: DEFAULT_POLICY, secret: SECRET });
  app = await buildKycServer(attester, { walletCooldownMs: 0, ...o });
  return { app, provider, store };
}
const post = (a: FastifyInstance, payload: unknown) => a.inject({ method: 'POST', url: '/v1/identity/attest', payload: payload as never });

describe('attester HTTP API', () => {
  it('attests and then reports the attestation as it is on chain', async () => {
    const { app, provider } = await make();
    provider.records.set(W1, active());
    const r = await post(app, { wallet: W1 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ wallet: W1, status: 'attested', country: 'IN', reasons: [] });
    const g = await app.inject({ url: `/v1/identity/${W1}` });
    expect(g.json()).toMatchObject({ wallet: W1, exists: true, valid: true, country: 'IN', tier: 1 });
    expect((await app.inject({ url: `/v1/identity/${W2}` })).json()).toEqual({ wallet: W2, exists: false });
  });
  it('answers an ineligible wallet 200 with the reasons, and an unreachable provider 503', async () => {
    const { app, provider } = await make();
    const r = await post(app, { wallet: W1 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ineligible', reasons: [{ code: 'NO_APASS' }] });
    provider.down = true;
    const d = await post(app, { wallet: W2 });
    expect(d.statusCode).toBe(503);
    expect(d.json()).toMatchObject({ status: 'provider_unavailable' });
  });
  it('rejects malformed input with 400 before asking the provider', async () => {
    const { app, provider } = await make();
    for (const body of [{}, { wallet: 5 }, { wallet: 'nope' }, { wallet: W1, extra: 1 }, [], { wallet: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0' }]) expect((await post(app, body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/identity/attest', headers: { 'content-type': 'application/json' }, payload: '{"wallet":' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/identity/attest', payload: 'x' })).statusCode).toBe(415);
    expect((await app.inject({ url: '/v1/identity/not-an-address' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/identity/attest', payload: 'x'.repeat(5_000), headers: { 'content-type': 'application/json' } })).statusCode).toBe(413);
    expect(provider.calls).toBe(0);
  });
  it('with a token configured, attestation requests need it (constant-time compare) and reads do not', async () => {
    const { app, provider } = await make({ authToken: 'k'.repeat(32) });
    provider.records.set(W1, active());
    const send = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/v1/identity/attest', payload: { wallet: W1 }, headers });
    expect((await send({})).statusCode).toBe(401);
    expect((await send({ authorization: 'Bearer ' + 'x'.repeat(32) })).statusCode).toBe(401);
    expect((await send({ authorization: 'Bearer short' })).statusCode).toBe(401);
    expect((await send({ authorization: 'k'.repeat(32) })).statusCode).toBe(401);
    expect(provider.calls).toBe(0);
    expect((await send({ authorization: 'Bearer ' + 'k'.repeat(32) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/identity/${W1}` })).statusCode).toBe(200);
  });
  it('limits each client address and each wallet', async () => {
    let t = 1_000_000;
    const { app, provider } = await make({ perMinute: 3, walletCooldownMs: 10_000, now: () => t });
    provider.records.set(W1, active());
    expect((await post(app, { wallet: W1 })).statusCode).toBe(200);
    const again = await post(app, { wallet: W1 });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    t += 11_000;
    expect((await post(app, { wallet: W1 })).statusCode).toBe(200);
    expect((await post(app, { wallet: W2 })).statusCode).toBe(429); // fourth request from this address inside the minute
    expect(provider.calls).toBe(2);
    t += 60_000;
    expect((await app.inject({ url: '/v1/health' })).statusCode).toBe(200);
    expect((await post(app, { wallet: W2 })).statusCode).toBe(200);
  });
  it('never returns provider data or the identity id', async () => {
    const { app, provider } = await make();
    provider.records.set(W1, active({ customerRef: 'PRIVATE-REF-42' }));
    const text = (await post(app, { wallet: W1 })).body + (await app.inject({ url: `/v1/identity/${W1}` })).body;
    expect(text).not.toMatch(/PRIVATE-REF|identity"|[0-9a-f]{64}/);
  });
});

describe('wallet-signed requests', () => {
  const NOW_MS = 1_800_000_000_000;
  const CHALLENGE_SECRET = new Uint8Array(32).fill(5);
  let t = NOW_MS;
  const setup = (o: ServerOptions = {}) => make({ challengeSecret: CHALLENGE_SECRET, now: () => t, ...o });
  const asksFor = async (a: FastifyInstance, wallet: string) => (await a.inject({ url: `/v1/identity/challenge?wallet=${wallet}` })).json() as { issuedAt: number; message: string; expiresAt: number };
  const sign = async (w: Awaited<ReturnType<typeof generateKeyPairSigner>>, message: string) => Buffer.from(await signBytes(w.keyPair.privateKey, new TextEncoder().encode(message))).toString('base64');

  it('does not offer a challenge unless it is configured, and checks the wallet it is asked about', async () => {
    const { app } = await make();
    expect((await app.inject({ url: `/v1/identity/challenge?wallet=${W1}` })).statusCode).toBe(404);
    const { app: signed } = await setup();
    expect((await signed.inject({ url: '/v1/identity/challenge?wallet=nope' })).statusCode).toBe(400);
    expect((await signed.inject({ url: '/v1/identity/challenge' })).statusCode).toBe(400);
    const c = await asksFor(signed, W1);
    expect(c.message).toContain(W1);
    expect(c.message).toMatch(/not a transaction and costs nothing/);
    expect(c.expiresAt - c.issuedAt).toBe(600);
  });

  it('records a verification only for the wallet that signed the challenge', async () => {
    t = NOW_MS;
    const { app, provider } = await setup();
    const alice = await generateKeyPairSigner();
    const mallory = await generateKeyPairSigner();
    provider.records.set(alice.address, active());
    const c = await asksFor(app, alice.address);
    // No signature: nobody may ask for someone else's wallet.
    const bare = await post(app, { wallet: alice.address });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toMatch(/sign the challenge/);
    // Another wallet's signature, a tampered time and a signature of some other text are all refused.
    for (const [who, issuedAt, text] of [[mallory, c.issuedAt, c.message], [alice, c.issuedAt + 1, c.message], [alice, c.issuedAt, c.message + ' '], [alice, c.issuedAt, 'hello']] as const) {
      const r = await post(app, { wallet: alice.address, issuedAt, signature: await sign(who, text) });
      expect(r.statusCode, `${who.address === alice.address ? 'alice' : 'mallory'} ${issuedAt} ${text.slice(0, 10)}`).toBe(401);
    }
    expect(provider.calls).toBe(0);
    // The wallet's own signature is accepted.
    const good = await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature: await sign(alice, c.message) });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ status: 'attested', country: 'IN' });
    expect(provider.calls).toBe(1);
  });

  it('refuses an expired challenge and a challenge from the future, and malformed fields', async () => {
    t = NOW_MS;
    const { app, provider } = await setup();
    const alice = await generateKeyPairSigner();
    provider.records.set(alice.address, active());
    const c = await asksFor(app, alice.address);
    const signature = await sign(alice, c.message);
    expect((await post(app, { wallet: alice.address, issuedAt: c.issuedAt })).statusCode).toBe(400);
    expect((await post(app, { wallet: alice.address, signature })).statusCode).toBe(400);
    expect((await post(app, { wallet: alice.address, issuedAt: 'now', signature })).statusCode).toBe(400);
    expect((await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature: 'AAAA' })).statusCode).toBe(400);
    t = NOW_MS + 601_000;
    const late = await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature });
    expect(late.statusCode).toBe(401);
    expect(late.json().error).toMatch(/expired/);
    t = NOW_MS - 120_000;
    expect((await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature })).statusCode).toBe(401);
    expect(provider.calls).toBe(0);
  });

  it('a refused request does not use up the wallet\'s lookup cooldown', async () => {
    t = NOW_MS;
    const { app, provider } = await setup({ walletCooldownMs: 10_000 });
    const alice = await generateKeyPairSigner();
    provider.records.set(alice.address, active());
    const c = await asksFor(app, alice.address);
    expect((await post(app, { wallet: alice.address })).statusCode).toBe(401);
    expect((await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature: await sign(alice, c.message) })).statusCode).toBe(200);
  });

  it('with a token as well, the operator\'s API needs no signature and a wallet needs no token', async () => {
    t = NOW_MS;
    const token = 't'.repeat(32);
    const { app, provider } = await setup({ authToken: token });
    const alice = await generateKeyPairSigner();
    provider.records.set(alice.address, active());
    provider.records.set(W2, active({ customerRef: 'CUST000000000002' }));
    expect((await app.inject({ method: 'POST', url: '/v1/identity/attest', payload: { wallet: W2 }, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/identity/attest', payload: { wallet: W2 }, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const c = await asksFor(app, alice.address);
    expect((await post(app, { wallet: alice.address, issuedAt: c.issuedAt, signature: await sign(alice, c.message) })).statusCode).toBe(200);
  });

  it('refuses a challenge secret that is too short', async () => {
    const attester = new Attester({ provider: new ScriptedProvider(), sas: new MemoryStore(), policy: DEFAULT_POLICY, secret: SECRET });
    await expect(buildKycServer(attester, { challengeSecret: new Uint8Array(31) })).rejects.toThrow(/32 bytes/);
  });
});
