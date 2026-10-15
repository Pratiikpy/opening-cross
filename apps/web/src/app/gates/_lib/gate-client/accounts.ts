// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// Decoders for the gate accounts the program writes by hand (ADR-0900), which Anchor's IDL therefore does not list:
// IdentityBinding, Volume and Allocation. Layouts mirror programs/cross_gate/src/lib.rs.
import {
  type Account,
  type Address,
  type EncodedAccount,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  assertAccountExists,
  decodeAccount,
  fixDecoderSize,
  getAddressDecoder,
  getBytesDecoder,
  getI64Decoder,
  getStructDecoder,
  getU64Decoder,
  getU8Decoder,
} from '@solana/kit';

/**
 * Anchor account discriminators: the first 8 bytes of sha256("account:<Name>"). The client has no hashing dependency, so
 * they are written out; test/client.test.ts recomputes each one and fails if a constant is wrong.
 */
export const IDENTITY_BINDING_DISCRIMINATOR = Uint8Array.of(30, 235, 86, 244, 103, 31, 24, 231);
export const VOLUME_DISCRIMINATOR = Uint8Array.of(202, 214, 22, 141, 94, 137, 154, 175);
export const ALLOCATION_DISCRIMINATOR = Uint8Array.of(147, 154, 3, 177, 155, 25, 131, 176);

export type IdentityBinding = { mint: Address; identity: ReadonlyUint8Array; wallet: Address; bump: number };
export type Volume = { mint: Address; owner: Address; windowStart: bigint; sold: bigint; bump: number };
export type Allocation = { cross: Address; key: ReadonlyUint8Array; reserved: bigint; bump: number };

const body = <T>(name: string, disc: Uint8Array, d: ReturnType<typeof getStructDecoder>) => ({
  decode(bytes: ReadonlyUint8Array): T {
    for (let i = 0; i < 8; i++) if (bytes[i] !== disc[i]) throw new Error(`not a ${name} account`);
    return d.decode(bytes.slice(8)) as T;
  },
});

const identityBindingDecoder = body<IdentityBinding>(
  'IdentityBinding',
  IDENTITY_BINDING_DISCRIMINATOR,
  getStructDecoder([['mint', getAddressDecoder()], ['identity', fixDecoderSize(getBytesDecoder(), 32)], ['wallet', getAddressDecoder()], ['bump', getU8Decoder()]]),
);
const volumeDecoder = body<Volume>(
  'Volume',
  VOLUME_DISCRIMINATOR,
  getStructDecoder([['mint', getAddressDecoder()], ['owner', getAddressDecoder()], ['windowStart', getI64Decoder()], ['sold', getU64Decoder()], ['bump', getU8Decoder()]]),
);
const allocationDecoder = body<Allocation>(
  'Allocation',
  ALLOCATION_DISCRIMINATOR,
  getStructDecoder([['cross', getAddressDecoder()], ['key', fixDecoderSize(getBytesDecoder(), 32)], ['reserved', getU64Decoder()], ['bump', getU8Decoder()]]),
);

export const decodeIdentityBinding = (data: ReadonlyUint8Array): IdentityBinding => identityBindingDecoder.decode(data);
export const decodeVolume = (data: ReadonlyUint8Array): Volume => volumeDecoder.decode(data);
export const decodeAllocation = (data: ReadonlyUint8Array): Allocation => allocationDecoder.decode(data);

/** Account sizes including the discriminator, for rent estimates. */
export const IDENTITY_BINDING_SIZE = 8 + 32 + 32 + 32 + 1;
export const VOLUME_SIZE = 8 + 32 + 32 + 8 + 8 + 1;
export const ALLOCATION_SIZE = 8 + 32 + 32 + 8 + 1;

export type { Account, EncodedAccount, MaybeEncodedAccount };
export { assertAccountExists, decodeAccount };
