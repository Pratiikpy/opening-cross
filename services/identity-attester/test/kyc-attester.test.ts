import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { deriveIdentityId } from '@opening-cross/cleanverse';
import { FLAG, unpackIdentityData } from '@opening-cross/cross-gate-client';
import { Attester, InvalidWalletError } from '../src/attester.js';
import { DEFAULT_POLICY } from '../src/decision.js';
import { MemoryStore, ScriptedProvider, SECRET, W1, W2, W3, active } from './helpers.js';

const NOW = 1_800_000_000;

function setup(policy = {}) {
  const provider = new ScriptedProvider();
  const store = new MemoryStore();
  const logs: string[] = [];
  let now = NOW;
  const attester = new Attester({ provider, sas: store, policy: { ...DEFAULT_POLICY, ...policy }, secret: SECRET, now: () => now, log: (l) => logs.push(l) });
  return { provider, store, attester, logs, setNow: (n: number) => void (now = n) };
}
const data = (s: MemoryStore, w: string) => unpackIdentityData(s.map.get(w)!.data);

describe('attest', () => {
  it('attests a wallet the provider vouches for, with the provider expiry', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active({ expiresAt: NOW + 5_000 }));
    const r = await attester.attest(W1);
    expect(r).toMatchObject({ status: 'attested', action: 'created', expiry: NOW + 5_000, country: 'IN', tier: 1, flags: FLAG.kyc });
    expect(store.map.get(W1)!.expiry).toBe(BigInt(NOW + 5_000));
    expect(data(store, W1)).toMatchObject({ country: 356, tier: 1, flags: FLAG.kyc });
  });

  it('the identity id is the HMAC of provider and customer: the same person on two wallets shares it, two people never do', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active({ customerRef: 'PERSON-A' }));
    provider.records.set(W2, active({ customerRef: 'PERSON-A' }));
    provider.records.set(W3, active({ customerRef: 'PERSON-B' }));
    for (const w of [W1, W2, W3]) await attester.attest(w);
    const id = (w: string) => Buffer.from(data(store, w).identity).toString('hex');
    expect(id(W1)).toBe(id(W2));
    expect(id(W1)).not.toBe(id(W3));
    expect(id(W1)).toBe(Buffer.from(deriveIdentityId(SECRET, 'scripted', 'PERSON-A')).toString('hex'));
  });

  it('is idempotent: attesting again changes nothing on chain; a changed record replaces it', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active());
    await attester.attest(W1);
    expect(await attester.attest(W1)).toMatchObject({ status: 'attested', action: 'unchanged' });
    expect(store.writes).toEqual([`create ${W1}`]);
    provider.records.set(W1, active({ tier: 1, expiresAt: 2_100_000_000 }));
    expect(await attester.attest(W1)).toMatchObject({ action: 'replaced', expiry: 2_100_000_000 });
  });

  it('refuses with the exact reason for each ineligible state and creates nothing', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, { ...(active() as object), state: 'frozen' } as never);
    provider.records.set(W2, active({ expiresAt: NOW - 10 }));
    provider.records.set(W3, active({ countries: [] }));
    const codes = async (w: string) => {
      const r = await attester.attest(w);
      return r.status === 'attested' ? ['attested'] : r.reasons.map((x) => x.code);
    };
    expect(await codes(W1)).toEqual(['APASS_FROZEN']);
    expect(await codes(W2)).toEqual(['APASS_EXPIRED']);
    expect(await codes(W3)).toEqual(['NO_COUNTRY']);
    expect(await codes('11111111111111111111111111111111')).toEqual(['NO_APASS']);
    expect(store.map.size).toBe(0);
  });

  it('an ineligible answer closes an attestation issued earlier (fail closed)', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active());
    await attester.attest(W1);
    provider.records.set(W1, { ...(active() as object), state: 'frozen' } as never);
    expect(await attester.attest(W1)).toMatchObject({ status: 'ineligible', closed: true });
    expect(store.map.has(W1)).toBe(false);
  });

  it('a provider that does not answer attests nothing and removes nothing', async () => {
    const { provider, store, attester } = setup();
    provider.down = true;
    expect(await attester.attest(W1)).toMatchObject({ status: 'provider_unavailable', closed: false });
    expect(store.map.size).toBe(0);
    provider.down = false;
    provider.records.set(W1, active());
    await attester.attest(W1);
    provider.down = true;
    expect(await attester.attest(W1)).toMatchObject({ status: 'provider_unavailable' });
    expect(store.map.has(W1)).toBe(true);
  });

  it('refuses wallets that are not Solana addresses before asking the provider', () => {
    const { provider, attester } = setup();
    for (const bad of ['', 'x', '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', W1 + 'aaa', 'O'.repeat(44)]) expect(() => attester.attest(bad), bad).toThrow(InvalidWalletError);
    expect(provider.calls).toBe(0);
  });

  it('serialises concurrent requests for one wallet: one write, not two', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active());
    const rs = await Promise.all([attester.attest(W1), attester.attest(W1), attester.attest(W1)]);
    expect(rs.map((r) => (r.status === 'attested' ? r.action : r.status)).sort()).toEqual(['created', 'unchanged', 'unchanged']);
    expect(store.writes).toHaveLength(1);
  });

  it('logs wallets and outcomes only: no customer reference, identity id or country', async () => {
    const { provider, attester, logs } = setup();
    provider.records.set(W1, active({ customerRef: 'SECRET-CUSTOMER-REF-123' }));
    await attester.attest(W1);
    provider.down = true;
    await attester.attest(W2);
    const all = logs.join('\n');
    expect(all).toContain(W1);
    expect(all).not.toMatch(/SECRET-CUSTOMER|[0-9a-f]{64}/);
  });

  it('needs a secret of at least 32 bytes', () => {
    expect(() => new Attester({ provider: new ScriptedProvider(), sas: new MemoryStore(), policy: DEFAULT_POLICY, secret: new Uint8Array(31) })).toThrow();
  });
});

describe('sync', () => {
  it('closes attestations of wallets that were frozen, removed or expired, and leaves good ones', async () => {
    const { provider, store, attester, setNow } = setup();
    for (const [w, ref] of [[W1, 'A'], [W2, 'B'], [W3, 'C']] as const) {
      provider.records.set(w, active({ customerRef: ref, expiresAt: NOW + 100_000 }));
      await attester.attest(w);
    }
    provider.records.set(W1, { ...(active({ customerRef: 'A' }) as object), state: 'frozen' } as never);
    provider.records.delete(W2); // the provider no longer knows the wallet
    const r = await attester.sync();
    expect(r).toMatchObject({ checked: 3, closed: 2, unchanged: 1, refreshed: 0, errors: [] });
    expect([...store.map.keys()]).toEqual([W3]);
    // Time passes: W3's pass expires at the provider.
    setNow(NOW + 100_001);
    expect(await attester.sync()).toMatchObject({ checked: 1, closed: 1 });
    expect(store.map.size).toBe(0);
  });

  it('refreshes an attestation whose expiry, tier or country moved', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active({ expiresAt: NOW + 1_000 }));
    await attester.attest(W1);
    provider.records.set(W1, active({ expiresAt: NOW + 9_000, countries: ['GB'] }));
    expect(await attester.sync()).toMatchObject({ refreshed: 1, closed: 0 });
    expect(store.map.get(W1)!.expiry).toBe(BigInt(NOW + 9_000));
    expect(data(store, W1).country).toBe(826);
    expect(await attester.sync()).toMatchObject({ unchanged: 1, refreshed: 0 });
  });

  it('a provider outage skips the wallet and leaves its attestation in place', async () => {
    const { provider, store, attester } = setup();
    provider.records.set(W1, active());
    await attester.attest(W1);
    provider.down = true;
    expect(await attester.sync()).toMatchObject({ checked: 1, skipped: 1, closed: 0, errors: [] });
    expect(store.map.has(W1)).toBe(true);
  });

  it('keeps going after one wallet fails and reports it', async () => {
    const { provider, store, attester } = setup();
    for (const w of [W1, W2]) {
      provider.records.set(w, active({ customerRef: w }));
      await attester.attest(w);
    }
    const realClose = store.close.bind(store);
    store.close = async (w: Address) => {
      if (w === W1) throw new Error('rpc exploded');
      return realClose(w);
    };
    provider.records.set(W1, { state: 'none' });
    provider.records.set(W2, { state: 'none' });
    const r = await attester.sync();
    expect(r.errors).toEqual([{ wallet: W1, message: 'rpc exploded' }]);
    expect(r.closed).toBe(1);
    expect(store.map.has(W2)).toBe(false);
  });
});

describe('onChain', () => {
  it('decodes the attestation and reports validity against the clock', async () => {
    const { provider, attester, setNow } = setup();
    expect(await attester.onChain(W1)).toEqual({ exists: false });
    provider.records.set(W1, active({ expiresAt: NOW + 1_000, countries: ['AE'] }));
    await attester.attest(W1);
    expect(await attester.onChain(W1)).toMatchObject({ exists: true, valid: true, country: 'AE', countryNumeric: 784, tier: 1, flags: FLAG.kyc, expiry: NOW + 1_000, cap: '0' });
    setNow(NOW + 1_000);
    expect(await attester.onChain(W1)).toMatchObject({ exists: true, valid: false });
    await expect(attester.onChain('nope')).rejects.toBeInstanceOf(InvalidWalletError);
  });
});
