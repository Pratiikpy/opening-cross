// Attestation nonces the treasury program derives (ADR-0472, ADR-0473). An attester signs the SAS
// attestation for a round or a milestone at the address derived from these nonces.
import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit';

const utf8 = (s: string) => new TextEncoder().encode(s);

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** The SAS attestation nonce of revenue round `round`: `sha256("oc-round" ‖ treasury ‖ round as u64 LE)`. */
export async function getRevenueRoundNonce(treasury: Address, round: bigint): Promise<Address> {
  const r = new Uint8Array(8);
  new DataView(r.buffer).setBigUint64(0, round, true);
  return getAddressDecoder().decode(await sha256(utf8('oc-round'), new Uint8Array(getAddressEncoder().encode(treasury)), r));
}

/** The SAS attestation nonce of milestone `index` of a grant: `sha256("oc-milestone" ‖ grant ‖ index as u8)`. */
export async function getGrantMilestoneNonce(grant: Address, index: number): Promise<Address> {
  return getAddressDecoder().decode(await sha256(utf8('oc-milestone'), new Uint8Array(getAddressEncoder().encode(grant)), new Uint8Array([index])));
}

/**
 * The data of a revenue attestation: the round's revenue in quote atoms, a little-endian u64. Create the
 * schema with SAS layout `[3]` (one u64 field) so the attester cannot write anything else.
 */
export function encodeRevenueAttestation(revenueAtoms: bigint): Uint8Array {
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, revenueAtoms, true);
  return d;
}
