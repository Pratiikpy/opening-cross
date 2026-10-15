// Test doubles for the attester's unit tests: an in-memory attestation store with the semantics of SasService, and a
// scriptable provider. The real store (SasService) is exercised against the real SAS binary in tests/core/test/identity-attester.test.ts.
import type { Address } from '@solana/kit';
import { type IdentityRecord, packIdentityData } from '@opening-cross/cross-gate-client';
import type { AttestationState, AttestationStore } from '../src/sas.js';
import { type KycProvider, type ProviderRecord, type VerifiedRecord, ProviderUnavailableError } from '../src/provider.js';

export class MemoryStore implements AttestationStore {
  readonly map = new Map<string, { data: Uint8Array; expiry: bigint }>();
  readonly writes: string[] = [];
  private readonly addr = (w: string) => `mem-${w}` as Address;

  async read(wallet: Address): Promise<AttestationState | null> {
    const a = this.map.get(wallet);
    return a ? { address: this.addr(wallet), wallet, expiry: a.expiry, data: a.data } : null;
  }
  async list(): Promise<AttestationState[]> {
    return [...this.map].map(([w, a]) => ({ address: this.addr(w), wallet: w as Address, expiry: a.expiry, data: a.data }));
  }
  async upsert(wallet: Address, record: IdentityRecord, expiry: bigint) {
    await Promise.resolve();
    const data = packIdentityData(record);
    const have = this.map.get(wallet);
    if (have && have.expiry === expiry && Buffer.compare(have.data, data) === 0) return { action: 'unchanged' as const, address: this.addr(wallet) };
    this.map.set(wallet, { data, expiry });
    this.writes.push(`${have ? 'replace' : 'create'} ${wallet}`);
    return { action: have ? ('replaced' as const) : ('created' as const), address: this.addr(wallet) };
  }
  async close(wallet: Address) {
    const had = this.map.delete(wallet);
    if (had) this.writes.push(`close ${wallet}`);
    return { closed: had };
  }
}

export class ScriptedProvider implements KycProvider {
  readonly records = new Map<string, ProviderRecord>();
  down = false;
  calls = 0;
  constructor(readonly name = 'scripted') {}
  async lookup(wallet: string): Promise<ProviderRecord> {
    this.calls++;
    await Promise.resolve();
    if (this.down) throw new ProviderUnavailableError('down');
    return this.records.get(wallet) ?? { state: 'none' };
  }
}

export const active = (o: Partial<VerifiedRecord> = {}): ProviderRecord => ({
  state: 'active',
  customerRef: 'CUST000000000001',
  tier: 1,
  countries: ['IN'],
  expiresAt: 2_000_000_000,
  kycVerified: true,
  sanctionsScreened: false,
  accredited: false,
  capAtoms: 0n,
  ...o,
});

// Valid 32-byte addresses (base58) for wallets.
export const W1 = '9wF7Yp8MZk2J6qX4R5GQKxE3P7H8YyNQ1JZVfA6mB2c';
export const W2 = '7hQqP8m3g4Q6Z8V2Lk1xT9RZsYF6M5EJ9B4CwD2A1nKp';
export const W3 = 'So11111111111111111111111111111111111111112';
export const SECRET = new Uint8Array(32).fill(7);
