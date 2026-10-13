// The parts of a cross with rules that are not the clearing rule but decide which orders it clears and when: the bucket an order lands in,
// the shards that must be merged, the draw (a drawn last counted bucket, a drawn extension length, the lottery start) and the vesting of a
// lock. Each function is written from the program source (programs/cross_core/src/{ext,draw,lock}.rs) and from the assertions of its Rust unit
// tests, not copied from the TypeScript helpers in `@opening-cross/cross-core-client`, so that the two can be compared.
//
// The vectors in `conformance/v3.json` pin each function; `generate_v3.py` writes them with a third implementation (Python integers) and
// `test/ending.test.ts` runs this file against them.

export const NO_BUCKET = 255;
export const AUX_END_BASE = 32;
export const AUX_EXT_BASE = 40;
export const MAX_EXT_SHARDS = 8;

/** Little-endian u64 at `at` of a 32-byte seed. */
export function seedWord(seed: Uint8Array, at: 0 | 8 | 16): bigint {
  if (seed.length !== 32) throw new Error('a draw seed is 32 bytes');
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(seed[at + i]!);
  return v;
}

/** The last counted ending bucket of a drawn ending: the first word of the seed, modulo the number of buckets (`draw_finish`, purpose 1, epoch 0). */
export function drawEndBucket(seed: Uint8Array, buckets: number): number {
  if (buckets < 1) throw new Error('an ending has at least one bucket');
  return Number(seedWord(seed, 0) % BigInt(buckets));
}

/** The length of a drawn extension in seconds: `min + (second word mod (max - min + 1))` (`draw_finish`, purpose 2). */
export function drawExtensionSecs(seed: Uint8Array, minSecs: number, maxSecs: number): number {
  if (maxSecs < minSecs || minSecs < 1) throw new Error('an extension runs from one second up, and its minimum does not exceed its maximum');
  return minSecs + Number(seedWord(seed, 8) % BigInt(maxSecs - minSecs + 1));
}

/** Where the class-1 lottery window starts among `tickets` tickets: the third word of the seed, modulo the tickets (`clear`, `marginal`). */
export function drawLotteryStart(seed: Uint8Array, tickets: number): number {
  if (tickets < 1) throw new Error('a lottery has at least one ticket');
  return Number(seedWord(seed, 16) % BigInt(tickets));
}

export type EndingShape = { endingSecs: number; buckets: number };

/** Epoch and ending bucket of an order placed at `now`, for a cross closing at `closeTs` (`CrossExt::placement`). `epoch` is the cross's current draw epoch. */
export function placementOf(e: EndingShape, epoch: number, closeTs: bigint, now: bigint): { epoch: number; bucket: number } {
  if (epoch > 0) return { epoch, bucket: NO_BUCKET };
  if (e.endingSecs === 0) return { epoch: 0, bucket: NO_BUCKET };
  const start = closeTs - BigInt(e.endingSecs);
  if (now < start) return { epoch: 0, bucket: NO_BUCKET };
  const b = ((now - start) * BigInt(e.buckets)) / BigInt(e.endingSecs);
  const last = BigInt(Math.max(e.buckets - 1, 0));
  return { epoch: 0, bucket: Number(b < last ? b : last) };
}

/** The last counted bucket: the drawn one, or the final bucket when nothing is drawn. */
export function lastCountedBucket(buckets: number, endBucket: number): number {
  return endBucket === NO_BUCKET ? Math.max(buckets - 1, 0) : endBucket;
}

/** Whether an order placed in `bucket` of `epoch` is left out of the clear by the draw. */
export function excludedByDraw(e: EndingShape, endBucket: number, orderEpoch: number, orderBucket: number): boolean {
  return e.endingSecs > 0 && orderEpoch === 0 && orderBucket !== NO_BUCKET && orderBucket > lastCountedBucket(e.buckets, endBucket);
}

/** The auxiliary shards that must be merged before the clear, as the bit mask of `aux_merged` (`CrossExt::required_aux`): buckets 0..last, and the extension shards after an extension. */
export function requiredAuxMask(e: EndingShape, endBucket: number, epoch: number, mainShards: number): bigint {
  let mask = 0n;
  if (e.endingSecs > 0) for (let b = 0; b <= lastCountedBucket(e.buckets, endBucket); b++) mask |= 1n << BigInt(b);
  if (epoch > 0) for (let j = 0; j < Math.min(Math.max(mainShards, 1), MAX_EXT_SHARDS); j++) mask |= 1n << BigInt(8 + j);
  return mask;
}

/** The bit of auxiliary shard `index` in `aux_merged`. */
export const auxBitOf = (index: number): bigint => (index >= AUX_EXT_BASE ? 1n << BigInt(8 + index - AUX_EXT_BASE) : 1n << BigInt(index - AUX_END_BASE));

/** Tokens of a lock vested at `now`: nothing before the cliff, everything at the cliff when there is no vesting period, a straight line over it after (`Lockup::vested`). */
export function lockVested(l: { amount: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }, now: bigint): bigint {
  const unlock = l.startTs + BigInt(l.cliffSecs);
  if (now < unlock) return 0n;
  if (l.vestSecs === 0) return l.amount;
  const part = (l.amount * (now - unlock)) / BigInt(l.vestSecs);
  return part > l.amount ? l.amount : part;
}

/** What can be released: vested less released (`Lockup::releasable`). */
export function lockReleasable(l: { amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }, now: bigint): bigint {
  const v = lockVested(l, now);
  return v > l.released ? v - l.released : 0n;
}
