// The Cleanverse provider and the whole attester against the local Cleanverse stub (a test double of the sandbox).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CleanverseClient } from '@opening-cross/cleanverse';
import { FLAG, unpackIdentityData } from '@opening-cross/cross-gate-client';
import { STUB_API_ID, STUB_API_KEY, StubCleanverse } from '../../../packages/cleanverse/test/stub-server.js';
import { Attester } from '../src/attester.js';
import { CleanverseProvider } from '../src/cleanverse-provider.js';
import { DEFAULT_POLICY } from '../src/decision.js';
import { MemoryStore, SECRET, W1, W2, W3 } from './helpers.js';

const stub = new StubCleanverse();
let base = '';
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  base = await stub.start();
});
afterAll(() => stub.stop());
beforeEach(() => {
  stub.passes.clear();
  stub.unlisted.clear();
  stub.failNext = null;
  stub.overrideNext = null;
});

const client = () => new CleanverseClient({ baseUrl: base, apiId: STUB_API_ID, apiKey: STUB_API_KEY, sleep: async () => {}, maxAttempts: 2 });
const provider = (o = {}) => new CleanverseProvider(client(), o);
const reasons = (r: Awaited<ReturnType<Attester['attest']>>) => r.reasons.map((x) => x.code);

describe('CleanverseProvider', () => {
  it('reads an active A-Pass into a normalised record', async () => {
    const p = stub.put({ chain: 'solana', walletAddress: W1, customerId: 'CUSTOMER0000000A', tier: '26', countries: ['SG', 'US'] });
    const rec = await provider().lookup(W1);
    expect(rec).toMatchObject({ state: 'active', customerRef: 'CUSTOMER0000000A', tier: 26, countries: ['SG', 'US'], expiresAt: p.expirationTime, kycVerified: true, sanctionsScreened: false, accredited: false });
  });
  it('an unknown wallet is "none"; a frozen pass is "frozen"', async () => {
    expect(await provider().lookup(W1)).toEqual({ state: 'none' });
    stub.put({ chain: 'solana', walletAddress: W2, status: 2 });
    expect(await provider().lookup(W2)).toMatchObject({ state: 'frozen' });
  });
  it('a pass the institution did not register cannot be linked to a customer', async () => {
    stub.put({ chain: 'solana', walletAddress: W1 });
    stub.unlisted.add(`solana:${W1}`);
    expect(await provider().lookup(W1)).toEqual({ state: 'unlinked' });
    // With the KYC-hash key the same pass is linkable.
    expect(await provider({ identityKey: 'kycHash' }).lookup(W1)).toMatchObject({ state: 'active' });
  });
  it('an empty KYC hash means no verified KYC data unless the operator assumes it', async () => {
    stub.put({ chain: 'solana', walletAddress: W1, currentKycHash: '' });
    expect(await provider().lookup(W1)).toMatchObject({ kycVerified: false });
    expect(await provider({ assumeKyc: true }).lookup(W1)).toMatchObject({ kycVerified: true });
    expect(await provider({ identityKey: 'kycHash' }).lookup(W1)).toEqual({ state: 'unlinked' });
  });
  it('anything but a clear "not found" is an outage, never "none": gateway refusal, 500, malformed, other business failure', async () => {
    stub.put({ chain: 'solana', walletAddress: W1 });
    const p = new CleanverseProvider(new CleanverseClient({ baseUrl: base, apiId: 'wrong', apiKey: STUB_API_KEY, sleep: async () => {} }));
    await expect(p.lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    stub.failNext = { count: 5, status: 500 };
    await expect(provider().lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    stub.failNext = null;
    stub.overrideNext = { status: 200, body: '{"code":"0000","message":"x","data":{"tier":"gold"}}' };
    await expect(provider().lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    stub.overrideNext = { status: 200, body: '{"code":"0002","message":"Failure. Please contact Cleanverse Support.","data":null}' };
    await expect(provider().lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
  });
});

describe('attester with Cleanverse', () => {
  const make = (policy = {}, o = {}) => {
    const store = new MemoryStore();
    return { store, attester: new Attester({ provider: provider(o), sas: store, policy: { ...DEFAULT_POLICY, ...policy }, secret: SECRET }) };
  };

  it('end to end: a registered wallet is attested with the pass expiry and country; two wallets of one customer share an identity', async () => {
    const exp = NOW + 30 * 86_400;
    stub.put({ chain: 'solana', walletAddress: W1, customerId: 'CUSTOMER00000001', countries: ['IN'], expirationTime: exp });
    stub.put({ chain: 'solana', walletAddress: W2, customerId: 'CUSTOMER00000001', countries: ['IN'], expirationTime: exp });
    stub.put({ chain: 'solana', walletAddress: W3, customerId: 'CUSTOMER00000002', countries: ['IN'], expirationTime: exp });
    const { store, attester } = make();
    for (const w of [W1, W2, W3]) expect(await attester.attest(w)).toMatchObject({ status: 'attested', expiry: exp, country: 'IN' });
    const id = (w: string) => Buffer.from(unpackIdentityData(store.map.get(w)!.data).identity).toString('hex');
    expect(id(W1)).toBe(id(W2));
    expect(id(W1)).not.toBe(id(W3));
    expect(unpackIdentityData(store.map.get(W1)!.data).flags).toBe(FLAG.kyc);
  });

  it('every state a user can be in, with the reason shown', async () => {
    const { attester } = make();
    expect(reasons(await attester.attest(W1))).toEqual(['NO_APASS']);
    stub.put({ chain: 'solana', walletAddress: W1, status: 2 });
    expect(reasons(await attester.attest(W1))).toEqual(['APASS_FROZEN']);
    stub.put({ chain: 'solana', walletAddress: W1, expirationTime: NOW - 100 });
    expect(reasons(await attester.attest(W1))).toEqual(['APASS_EXPIRED']);
    stub.put({ chain: 'solana', walletAddress: W1, countries: [] });
    expect(reasons(await attester.attest(W1))).toEqual(['NO_COUNTRY']);
    stub.put({ chain: 'solana', walletAddress: W1, countries: ['IN', 'US'] });
    expect(reasons(await attester.attest(W1))).toEqual(['AMBIGUOUS_COUNTRY']);
    stub.put({ chain: 'solana', walletAddress: W1 });
    stub.unlisted.add(`solana:${W1}`);
    expect(reasons(await attester.attest(W1))).toEqual(['APASS_NOT_LINKED']);
    stub.failNext = { count: 9, status: 503 };
    expect(await attester.attest(W1)).toMatchObject({ status: 'provider_unavailable' });
  });

  it('a wallet on another chain is not found: the provider is asked about Solana only', async () => {
    stub.put({ chain: 'base', walletAddress: W1 });
    const { attester } = make();
    expect(reasons(await attester.attest(W1))).toEqual(['NO_APASS']);
  });

  it('sync closes the attestation when Cleanverse freezes the A-Pass and restores nothing by itself', async () => {
    stub.put({ chain: 'solana', walletAddress: W1 });
    const { store, attester } = make();
    await attester.attest(W1);
    expect(store.map.has(W1)).toBe(true);
    await client().updateStatus({ chain: 'solana', address: W1, status: 'freeze', blacklistReason: 'test' });
    expect(await attester.sync()).toMatchObject({ checked: 1, closed: 1 });
    expect(store.map.size).toBe(0);
    await client().updateStatus({ chain: 'solana', address: W1, status: 'activate' });
    expect(await attester.sync()).toMatchObject({ checked: 0 });
    expect(await attester.attest(W1)).toMatchObject({ status: 'attested', action: 'created' });
  });

  it('a generated A-Pass (identity document country) flows through to the attested country', async () => {
    await client().generateApass({ customerId: 'CUSTOMER00000009', expirationTime: NOW + 1_000_000, wallet: { address: W1, chain: 'solana' }, identityDataList: [{ idType: 'PASSPORT', fullName: 'Test Person', issuingCountryISO2: 'ae' }] });
    stub.passes.get(`solana:${W1}`)!.tier = '3';
    const { attester } = make();
    expect(await attester.attest(W1)).toMatchObject({ status: 'attested', country: 'AE', tier: 1 });
  });
});
