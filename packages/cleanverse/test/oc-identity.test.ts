// Pins the byte layout of the `oc-identity` v1 attestation data against a literal vector written from the specification
// (44 bytes: identity 0..32, country u16 LE 32..34, tier 34, flags 35, cap u64 LE 36..44), independent of the code that
// packs it, so a change in the gate client's encoder cannot pass silently.
import { describe, expect, it } from 'vitest';
import { FLAG, IDENTITY_SCHEMA, Tier, deriveIdentityId, packIdentityData, unpackIdentityData } from '../src/oc-identity.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

describe('oc-identity v1', () => {
  it('packs to the specified bytes', () => {
    const identity = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const bytes = packIdentityData({ identity, country: 356, tier: Tier.accredited, flags: FLAG.kyc | FLAG.sanctionsClear, cap: 5_000_000n });
    expect(hex(bytes)).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' + '6401' + '02' + '0c' + '404b4c0000000000');
    expect(bytes).toHaveLength(44);
    expect(unpackIdentityData(bytes)).toEqual({ identity, country: 356, tier: 2, flags: 12, cap: 5_000_000n });
  });
  it('declares the layout U128,U128,U16,U8,U8,U64 with the specified field names', () => {
    expect(Array.from(IDENTITY_SCHEMA.layout)).toEqual([4, 4, 1, 0, 0, 3]);
    expect(IDENTITY_SCHEMA.fieldNames).toEqual(['id_a', 'id_b', 'country', 'tier', 'flags', 'cap']);
    expect([IDENTITY_SCHEMA.name, IDENTITY_SCHEMA.version]).toEqual(['oc-identity', 1]);
  });
  it('refuses reserved flag bits and out-of-range fields', () => {
    const base = { identity: new Uint8Array(32), country: 356, tier: 1, flags: 0, cap: 0n };
    expect(() => packIdentityData({ ...base, flags: 0x10 })).toThrow();
    expect(() => packIdentityData({ ...base, tier: 4 })).toThrow();
    expect(() => packIdentityData({ ...base, country: 1000 })).toThrow();
    expect(() => packIdentityData({ ...base, cap: -1n })).toThrow();
    expect(() => unpackIdentityData(new Uint8Array(43))).toThrow();
  });
  it('derives the identity id as HMAC-SHA256(secret, provider ":" customer id)', () => {
    const secret = new Uint8Array(32).fill(9);
    const id = deriveIdentityId(secret, 'cleanverse', 'CUST000000000001');
    expect(id).toHaveLength(32);
    // Independent computation with node:crypto.
    return import('node:crypto').then(({ createHmac }) => {
      expect(hex(id)).toBe(createHmac('sha256', Buffer.from(secret)).update('cleanverse:CUST000000000001').digest('hex'));
      expect(hex(deriveIdentityId(secret, 'cleanverse', 'CUST000000000002'))).not.toBe(hex(id));
      expect(hex(deriveIdentityId(secret, 'manual', 'CUST000000000001'))).not.toBe(hex(id));
      expect(() => deriveIdentityId(new Uint8Array(16), 'cleanverse', 'x')).toThrow();
    });
  });
});
