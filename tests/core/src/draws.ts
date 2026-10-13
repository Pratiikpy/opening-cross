// Helpers for the two-step draw (ADR-0452) on LiteSVM: the SlotHashes sysvar is set by hand so a test knows
// the seed the program will compute.
import { createHash } from 'node:crypto';
import { type Address, getAddressEncoder, getBase58Decoder } from '@solana/kit';
import type { World } from './world.js';

export const hashOf = (slot: bigint) => createHash('sha256').update(`slot-${slot}`).digest();
const b58 = getBase58Decoder();

/** Fills the SlotHashes sysvar with a contiguous run of slots, newest first. */
export function slotHashesFor(w: World, from: bigint, to: bigint) {
  const list: { slot: bigint; hash: string }[] = [];
  for (let s = to; s >= from; s--) list.push({ slot: s, hash: b58.decode(hashOf(s)) });
  w.h.svm.setSlotHashes(list);
}

/** The seed `draw_finish` computes for a draw begun at `begun` (ADR-0452): the hashes of the first recorded slots at or after `begun + 4k`, k = 1..4. */
export function expectedSeed(cross: Address, epoch: number, purpose: number, begun: bigint): Buffer {
  const parts = [Buffer.from('opening-cross/draw/v1'), Buffer.from(getAddressEncoder().encode(cross)), Buffer.from([epoch, purpose])];
  for (const k of [4n, 8n, 12n, 16n]) parts.push(hashOf(begun + k));
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}
