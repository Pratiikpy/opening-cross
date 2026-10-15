import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FLAG } from '@opening-cross/cross-gate-client';
import { AllowlistProvider } from '../src/allowlist-provider.js';
import { Attester } from '../src/attester.js';
import { DEFAULT_POLICY } from '../src/decision.js';
import { MemoryStore, SECRET, W1, W2 } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'allow-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'allow.json');
const write = (wallets: unknown) => writeFileSync(file, JSON.stringify({ wallets }));

describe('manual allowlist provider', () => {
  it('attests a listed wallet and honours every field the file can carry', async () => {
    write({ [W1]: { customerRef: 'alice-1', tier: 2, country: 'gb', expiresAt: 2_000_000_000, kycVerified: true, sanctionsScreened: true, accredited: true, capAtoms: '2500000' } });
    const store = new MemoryStore();
    const a = new Attester({ provider: new AllowlistProvider(file), sas: store, policy: { ...DEFAULT_POLICY, accreditedMin: 2 }, secret: SECRET, now: () => 1_800_000_000 });
    expect(await a.attest(W1)).toMatchObject({ status: 'attested', country: 'GB', tier: 2, flags: FLAG.kyc | FLAG.sanctionsClear | FLAG.accredited, expiry: 2_000_000_000 });
    expect(await a.onChain(W1)).toMatchObject({ cap: '2500000' });
  });
  it('an edit that removes or freezes a wallet is enforced by the next sync', async () => {
    write({ [W1]: { customerRef: 'a', tier: 1, country: 'IN', kycVerified: true }, [W2]: { customerRef: 'b', tier: 1, country: 'IN', kycVerified: true } });
    const store = new MemoryStore();
    const a = new Attester({ provider: new AllowlistProvider(file), sas: store, policy: DEFAULT_POLICY, secret: SECRET });
    await a.attest(W1);
    await a.attest(W2);
    write({ [W2]: { customerRef: 'b', tier: 1, country: 'IN', kycVerified: true, frozen: true } });
    expect(await a.sync()).toMatchObject({ checked: 2, closed: 2 });
    expect(store.map.size).toBe(0);
  });
  it('a missing, unreadable or malformed file is an outage, not an empty list', async () => {
    const p = new AllowlistProvider(join(dir, 'missing.json'));
    await expect(p.lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    writeFileSync(file, 'not json');
    await expect(new AllowlistProvider(file).lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    for (const bad of [{ customerRef: '', tier: 1 }, { customerRef: 'x', tier: -1 }, { customerRef: 'x', tier: 1, country: 'IND' }, { customerRef: 'x', tier: 1, capAtoms: '-1' }, { customerRef: 'x', tier: 1, expiresAt: 'soon' }]) {
      write({ [W1]: bad });
      await expect(new AllowlistProvider(file).lookup(W1), JSON.stringify(bad)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    }
    writeFileSync(file, JSON.stringify({ nope: 1 }));
    await expect(new AllowlistProvider(file).lookup(W1)).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
  });
  it('an unlisted wallet is "none"', async () => {
    write({});
    expect(await new AllowlistProvider(file).lookup(W1)).toEqual({ state: 'none' });
  });
});
