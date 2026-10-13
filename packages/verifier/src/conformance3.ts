// Conformance suite v3 (`opening-cross/conformance/v3`): the parts of a cross with rules that are not the clearing rule: which ending bucket an order
// lands in, which auxiliary shards a clear needs, what a draw's seed decides (the last counted bucket, an extension's length, where the lottery starts)
// and how a lock vests. Same contract as v1 and v2: an implementation conforms only if it reproduces every case exactly.
//
// The expected values come from `conformance/generate_v3.py`, which computes them from the specification and the program source with Python integers.
// They are not produced by running the Rust code, and the file says so (`source`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawEndBucket, drawExtensionSecs, drawLotteryStart, excludedByDraw, lockReleasable, lockVested, placementOf, requiredAuxMask } from './ending.js';

export const CONFORMANCE3_SCHEMA = 'opening-cross/conformance/v3';

export type ConformanceCase3 =
  | { kind: 'placement'; tag: string; endingSecs: number; buckets: number; epoch: number; closeTs: string; now: string; expect: { epoch: number; bucket: number } }
  | { kind: 'required_aux'; endingSecs: number; buckets: number; endBucket: number; epoch: number; shards: number; expect: string }
  | { kind: 'excluded'; endingSecs: number; buckets: number; endBucket: number; orderEpoch: number; orderBucket: number; expect: boolean }
  | { kind: 'draw_end_bucket'; seed: string; buckets: number; expect: number }
  | { kind: 'draw_extension_secs'; seed: string; minSecs: number; maxSecs: number; expect: number }
  | { kind: 'draw_lottery_start'; seed: string; tickets: number; expect: number }
  | { kind: 'lock'; amount: string; released: string; startTs: string; cliffSecs: number; vestSecs: number; now: string; expect: { vested: string; releasable: string } };

export type ConformanceVectors3 = { schema: string; source: string; generator: string; cases: ConformanceCase3[] };
export type Result3 = ConformanceCase3['expect'];
export type Implementation3 = (c: ConformanceCase3) => Result3;

export function loadVectors3(path = fileURLToPath(new URL('../conformance/v3.json', import.meta.url))): ConformanceVectors3 {
  const v = JSON.parse(readFileSync(path, 'utf8')) as ConformanceVectors3;
  if (v.schema !== CONFORMANCE3_SCHEMA) throw new Error(`unexpected schema ${v.schema}`);
  return v;
}

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

/** The verifier's own implementation (`ending.ts`). */
export const referenceImplementation3: Implementation3 = (c) => {
  switch (c.kind) {
    case 'placement':
      return placementOf({ endingSecs: c.endingSecs, buckets: c.buckets }, c.epoch, BigInt(c.closeTs), BigInt(c.now));
    case 'required_aux':
      return requiredAuxMask({ endingSecs: c.endingSecs, buckets: c.buckets }, c.endBucket, c.epoch, c.shards).toString();
    case 'excluded':
      return excludedByDraw({ endingSecs: c.endingSecs, buckets: c.buckets }, c.endBucket, c.orderEpoch, c.orderBucket);
    case 'draw_end_bucket':
      return drawEndBucket(hex(c.seed), c.buckets);
    case 'draw_extension_secs':
      return drawExtensionSecs(hex(c.seed), c.minSecs, c.maxSecs);
    case 'draw_lottery_start':
      return drawLotteryStart(hex(c.seed), c.tickets);
    case 'lock': {
      const l = { amount: BigInt(c.amount), released: BigInt(c.released), startTs: BigInt(c.startTs), cliffSecs: c.cliffSecs, vestSecs: c.vestSecs };
      return { vested: lockVested(l, BigInt(c.now)).toString(), releasable: lockReleasable(l, BigInt(c.now)).toString() };
    }
  }
};

export function runConformance3(vectors: ConformanceVectors3, impl: Implementation3): { index: number; kind: string; expected: Result3; actual: Result3 | { threw: string } }[] {
  const failures: { index: number; kind: string; expected: Result3; actual: Result3 | { threw: string } }[] = [];
  for (const [index, c] of vectors.cases.entries()) {
    let actual: Result3 | { threw: string };
    let threw = false;
    try {
      actual = impl(c);
    } catch (e) {
      threw = true;
      actual = { threw: e instanceof Error ? e.message : String(e) };
    }
    if (threw || JSON.stringify(actual) !== JSON.stringify(c.expect)) failures.push({ index, kind: c.kind, expected: c.expect, actual });
  }
  return failures;
}
