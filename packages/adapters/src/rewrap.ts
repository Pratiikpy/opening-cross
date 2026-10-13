// New settlement instructions that take an existing instruction's arguments as a byte string (ADR-0482, ADR-0483, ADR-0485).
//
// `open_dbc_pool_locked`, `seed_damm_v2_batched`, `open_dlmm_pair_badged` and the other variants carry the Borsh encoding of the
// original instruction's arguments as `Vec<u8>`, so the original instruction keeps the exact argument names and shape it was deployed
// with. This builds the variant from the original instruction: same accounts in the same order, the original argument bytes
// length-prefixed, and any trailing arguments appended.
import { createHash } from 'node:crypto';
import type { Instruction } from '@solana/kit';

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

export function rewrapInstruction(original: Instruction, variant: string, trailing: Uint8Array = new Uint8Array()): Instruction {
  if (!original.data || original.data.length < 8) throw new Error('the original instruction has no data');
  const payload = Buffer.from(original.data.subarray(8));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  return { ...original, data: new Uint8Array(Buffer.concat([disc(variant), length, payload, Buffer.from(trailing)])) } as Instruction;
}

export const i64le = (v: number | bigint): Uint8Array => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return new Uint8Array(b);
};
