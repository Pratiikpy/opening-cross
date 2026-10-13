import { describe, expect, it, vi } from 'vitest';
import { type Address, generateKeyPairSigner, signBytes } from '@solana/kit';
import { CHALLENGE_TTL_SECONDS, challengeMessage, verifyChallenge } from '../src/challenge.js';
import { buildAttester } from '../src/server.js';
import type { Issued } from '../src/chain.js';

const secret = new Uint8Array(32).fill(7);
const NOW = 1_800_000_000;

async function signed(issuedAt = NOW, secretUsed = secret) {
  const w = await generateKeyPairSigner();
  const message = challengeMessage(secretUsed, w.address, issuedAt);
  const sig = await signBytes(w.keyPair.privateKey, new TextEncoder().encode(message));
  return { wallet: w.address, w, message, signature: new Uint8Array(sig), b64: Buffer.from(sig).toString('base64') };
}

describe('challenge', () => {
  it('accepts the wallet\'s own signature over the issued text', async () => {
    const s = await signed();
    expect(await verifyChallenge({ secret, wallet: s.wallet, issuedAt: NOW, signature: s.signature, now: NOW + 5 })).toEqual({ ok: true });
  });

  it('refuses another wallet\'s signature, a wrong secret, a tampered time, an old or future challenge, a short signature', async () => {
    const s = await signed();
    const other = await generateKeyPairSigner();
    expect(await verifyChallenge({ secret, wallet: other.address, issuedAt: NOW, signature: s.signature, now: NOW })).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(await verifyChallenge({ secret: new Uint8Array(32).fill(8), wallet: s.wallet, issuedAt: NOW, signature: s.signature, now: NOW })).toMatchObject({ ok: false });
    expect(await verifyChallenge({ secret, wallet: s.wallet, issuedAt: NOW + 1, signature: s.signature, now: NOW + 2 })).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(await verifyChallenge({ secret, wallet: s.wallet, issuedAt: NOW, signature: s.signature, now: NOW + CHALLENGE_TTL_SECONDS + 1 })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await verifyChallenge({ secret, wallet: s.wallet, issuedAt: NOW + 600, signature: s.signature, now: NOW })).toMatchObject({ ok: false, reason: 'from the future' });
    expect(await verifyChallenge({ secret, wallet: s.wallet, issuedAt: NOW, signature: s.signature.slice(0, 63), now: NOW })).toMatchObject({ ok: false, reason: 'malformed signature' });
  });

  it('says in the text itself that it proves wallet control only', async () => {
    const m = challengeMessage(secret, (await generateKeyPairSigner()).address, NOW);
    expect(m).toMatch(/only proves you control the wallet/);
    expect(m).toMatch(/not KYC/);
  });
});

describe('attester HTTP', () => {
  const credential = '11111111111111111111111111111112' as Address;
  const schema = '11111111111111111111111111111113' as Address;
  const make = async (over: { hourlyCap?: number; issue?: (w: Address) => Promise<Issued> } = {}) => {
    const issue = vi.fn(over.issue ?? (async (w: Address): Promise<Issued> => ({ attestation: w, expiry: 1_802_592_000n, signature: 'sig', reused: false })));
    const app = await buildAttester({ credential, schema, attester: credential, secret, ttlSeconds: 2_592_000, hourlyCap: over.hourlyCap ?? 30, issue, clock: () => NOW });
    return { app, issue };
  };

  it('states plainly what it checks and what it does not', async () => {
    const { app } = await make();
    const r = (await app.inject({ method: 'GET', url: '/v1/attester' })).json();
    expect(r.label).toBe('devnet test attester: no real identity verification');
    expect(r.notChecked).toContain('accredited-investor status');
  });

  it('issues only after a valid signature, and is idempotent per request', async () => {
    const { app, issue } = await make();
    const s = await signed();
    const ch = (await app.inject({ method: 'GET', url: `/v1/attester/challenge?wallet=${s.wallet}` })).json();
    expect(ch.message).toBe(s.message);
    const bad = await app.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: s.wallet, issuedAt: NOW, signature: Buffer.alloc(64).toString('base64') } });
    expect(bad.statusCode).toBe(403);
    expect(issue).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: s.wallet, issuedAt: NOW, signature: s.b64 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ wallet: s.wallet, attestation: s.wallet, credential, schema });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('refuses junk with a 4xx and never calls the chain', async () => {
    const { app, issue } = await make();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/attester/attest', payload: payload as never });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ wallet: 'x', issuedAt: NOW, signature: 'x' })).statusCode).toBe(400);
    const w = (await generateKeyPairSigner()).address;
    expect((await post({ wallet: w, issuedAt: 'now', signature: 'x' })).statusCode).toBe(400);
    expect((await post({ wallet: w, issuedAt: NOW, signature: 'not base64' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/attester/challenge?wallet=nope' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/attester/challenge' })).statusCode).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it('stops at the hourly cap so a flood cannot drain the operator', async () => {
    const { app } = await make({ hourlyCap: 1 });
    const a = await signed();
    const b = await signed();
    const go = (s: Awaited<ReturnType<typeof signed>>) => app.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: s.wallet, issuedAt: NOW, signature: s.b64 } });
    expect((await go(a)).statusCode).toBe(200);
    expect((await go(b)).statusCode).toBe(429);
  });

  it('reports a chain failure as 502 with nothing issued', async () => {
    const { app } = await make({ issue: async () => { throw new Error('rpc down'); } });
    const s = await signed();
    const r = await app.inject({ method: 'POST', url: '/v1/attester/attest', payload: { wallet: s.wallet, issuedAt: NOW, signature: s.b64 } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/nothing was issued/);
  });
});
