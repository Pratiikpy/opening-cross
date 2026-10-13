// A market maker's signed registration (PRODUCT_FEATURES W7, Z7). Registering is permissionless and needs only the maker's
// own signature, so nobody can register a wallet that did not ask for it. The registration states the obligation the maker
// accepts to be held to; `obligations.ts` measures it from the orders on chain.
import { type Address, address as toAddress, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Json, hashJcs } from '@opening-cross/promises';
import { isSolanaAddress } from './quote.js';

export const REGISTRATION_SCHEMA = 'opening-cross/maker-registration/v1';
export const REGISTRATION_DOMAIN = 'opening-cross/maker-registration/v1\n';

export type RegistrationBody = {
  readonly schema: typeof REGISTRATION_SCHEMA;
  readonly maker: string;
  /** A label shown next to the maker; 1 to 40 printable characters, no control characters. It is data, never an instruction. */
  readonly name: string;
  /** Base atoms the maker commits to quote on each side of a cross, decimal string. */
  readonly minQuantity: string;
  readonly maxSpreadBps: number;
  /** Unix seconds when signed. A later registration from the same maker replaces an earlier one. */
  readonly issuedAt: number;
  readonly nonce: string;
};

export type SignedRegistration = { readonly body: RegistrationBody; readonly id: string; readonly signature: string };

export class RegistrationError extends Error {
  override readonly name = 'RegistrationError';
}

/** The widest spread a registration may promise; a wider one would promise nothing. */
export const MAX_REGISTERABLE_SPREAD_BPS = 2_000;

export function validateRegistration(b: RegistrationBody): void {
  if (b.schema !== REGISTRATION_SCHEMA) throw new RegistrationError(`unknown schema ${String(b.schema)}`);
  if (!isSolanaAddress(b.maker)) throw new RegistrationError('maker must be a Solana address');
  if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 40 || /[\u0000-\u001f\u007f]/.test(b.name)) throw new RegistrationError('name must be 1 to 40 printable characters');
  if (typeof b.minQuantity !== 'string' || !/^[1-9][0-9]{0,19}$/.test(b.minQuantity) || BigInt(b.minQuantity) >= 1n << 64n) throw new RegistrationError('minQuantity must be a positive 64-bit integer as a decimal string');
  if (!Number.isInteger(b.maxSpreadBps) || b.maxSpreadBps < 1 || b.maxSpreadBps > MAX_REGISTERABLE_SPREAD_BPS) throw new RegistrationError(`maxSpreadBps must be an integer from 1 to ${MAX_REGISTERABLE_SPREAD_BPS}`);
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt <= 0) throw new RegistrationError('issuedAt must be a unix time in seconds');
  if (!/^[0-9a-f]{16,64}$/.test(b.nonce)) throw new RegistrationError('nonce must be 16 to 64 lowercase hex characters');
}

export const registrationId = (b: RegistrationBody): string => {
  validateRegistration(b);
  return hashJcs(b as unknown as Json);
};

const message = (id: string): Uint8Array => new TextEncoder().encode(REGISTRATION_DOMAIN + id);

export async function signRegistration(body: RegistrationBody, keyPair: CryptoKeyPair): Promise<SignedRegistration> {
  const id = registrationId(body);
  return { body, id, signature: bytesToHex(await signBytes(keyPair.privateKey, message(id))) };
}

/** True when the body is valid, the id matches it and the maker's key signed it. A registration is not time-limited. */
export async function verifyRegistration(s: SignedRegistration): Promise<boolean> {
  try {
    if (registrationId(s.body) !== s.id || !/^[0-9a-f]{128}$/.test(s.signature)) return false;
    const key = await getPublicKeyFromAddress(toAddress(s.body.maker) as Address);
    return await verifySignature(key, hexToBytes(s.signature) as SignatureBytes, message(s.id));
  } catch {
    return false;
  }
}
