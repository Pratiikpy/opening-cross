// The `oc-identity` v1 attestation bytes and schema constants are owned by the gate client (ADR-0900), which is the code the
// program's tests run against. They are re-exported here so the attester and this package use the one implementation; the
// byte layout is pinned independently by a literal vector in test/oc-identity.test.ts.
import { createHmac } from 'node:crypto';

export {
  ACCREDITATION_SCHEMA,
  FLAG,
  FLAGS_KNOWN,
  IDENTITY_DATA_LENGTH,
  IDENTITY_SCHEMA,
  Tier,
  packIdentityData,
  unpackIdentityData,
  type IdentityRecord,
} from '@opening-cross/cross-gate-client';

/**
 * The identity id for a provider's customer: HMAC-SHA256 keyed with the attester's secret over `provider ":" customerId`.
 * Unique per person per provider, stable across that person's wallets, and not reversible to the customer id without the
 * secret, so a leaked set of attestations reveals nothing about who anyone is. Losing the secret changes every id (it
 * cannot be recovered), which is why the runbook has it backed up offline.
 */
export function deriveIdentityId(attesterSecret: Uint8Array, provider: string, customerId: string): Uint8Array {
  if (attesterSecret.length < 32) throw new Error('the attester secret must be at least 32 bytes');
  if (provider.length === 0 || customerId.length === 0) throw new Error('provider and customerId are required');
  return Uint8Array.from(createHmac('sha256', attesterSecret).update(`${provider}:${customerId}`).digest());
}
