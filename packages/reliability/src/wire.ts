import { getBase58Decoder } from '@solana/kit';

export const bytesToBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

/** A transaction's id is its first signature: byte 0 of the wire format is the signature count, then 64 bytes each. */
export function signatureOf(wire: Uint8Array): string {
  return getBase58Decoder().decode(wire.slice(1, 65));
}
