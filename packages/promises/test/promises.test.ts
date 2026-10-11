import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  type BookSnapshot,
  DEFAULT_POLICY,
  type GradedSample,
  type GradedRecord,
  bucketOf,
  buildPromise,
  calibrateCell,
  canonicalize,
  conformalQuantile,
  gradeClearBand,
  hashJcs,
  indicativeTick,
  intervalScore,
  issueClearBand,
  lastPerCrossBucket,
  minSamplesFor,
  pinball,
  prequential,
  report,
  samplesOf,
  signPromiseWith,
  verifyPromiseId,
  verifySigned,
  wilson,
} from '../src/index.js';

// ---- a fixed pseudo-random stream so every run sees the same crosses
function rng(seed: number) {
  let s = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  const mask = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & mask;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return Number((z ^ (z >> 31n)) >> 11n) / 2 ** 53;
  };
}

const GRID = { minPrice: '1000000', tick: '50000', ticks: 40, priceScale: '1000000' };
function book(levels: [number, bigint, bigint][], referenceTick: number | null = null): BookSnapshot {
  const buy = new Array<bigint>(GRID.ticks).fill(0n);
  const sell = new Array<bigint>(GRID.ticks).fill(0n);
  for (const [t, b, s] of levels) {
    buy[t] = b;
    sell[t] = s;
  }
  return { grid: GRID, buy, sell, referenceTick };
}
const CROSSING = book([[10, 5n, 0n], [6, 0n, 5n]]);

describe('canonical JSON', () => {
  it('sorts keys, drops undefined and is order independent', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(hashJcs({ a: 1, b: 2 })).toBe(hashJcs({ b: 2, a: 1 }));
    expect(hashJcs({ a: 1 })).not.toBe(hashJcs({ a: 2 }));
  });
  it('refuses floats, so no promise can depend on a rounding mode', () => {
    expect(() => canonicalize({ x: 0.5 })).toThrow(/integers only/);
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: 2 ** 60 })).toThrow();
  });
  it('is stable for unicode and escapes', () => {
    expect(canonicalize('é"\n')).toBe('"é\\"\\n"');
  });
});

describe('statistics', () => {
  it('Wilson interval brackets the proportion and tightens with n', () => {
    const a = wilson(9, 10);
    const b = wilson(900, 1000);
    expect(a.lo).toBeLessThan(0.9);
    expect(a.hi).toBeGreaterThan(0.9);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
  it('interval score: width plus a penalty scaled by 2/α for the miss', () => {
    expect(intervalScore(10, 20, 15, 1_000)).toBe(10);
    // α = 10%: miss by 5 below → width 10 + (2/0.1)·5 = 110
    expect(intervalScore(10, 20, 5, 1_000)).toBe(110);
    expect(intervalScore(10, 20, 26, 1_000)).toBe(10 + 20 * 6);
  });
  it('pinball loss is asymmetric', () => {
    expect(pinball(10, 12, 0.9)).toBeCloseTo(1.8);
    expect(pinball(10, 7, 0.9)).toBeCloseTo(0.3);
  });
});

describe('conformal quantile', () => {
  it('is the ceil((n+1)·nominal)-th smallest score', () => {
    const scores = [5, 1, 3, 2, 4, 9, 8, 7, 6, 0];
    // n = 10, 90%: ceil(11 × 0.9) = 10 → the largest
    expect(conformalQuantile(scores, 9_000)).toBe(9);
    // 80%: ceil(11 × 0.8) = 9 → 9th smallest
    expect(conformalQuantile(scores, 8_000)).toBe(8);
  });
  it('refuses to answer when the rank exceeds n, instead of using the largest score', () => {
    expect(conformalQuantile([1, 2, 3, 4, 5, 6, 7, 8], 9_000)).toBeUndefined(); // ceil(9 × 0.9) = 9 > 8
    expect(conformalQuantile([], 9_000)).toBeUndefined();
    expect(minSamplesFor(9_000)).toBe(9);
    expect(conformalQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9], 9_000)).toBe(9);
  });
  it('rejects a nominal coverage outside (0, 100%)', () => {
    expect(() => conformalQuantile([1], 0)).toThrow(RangeError);
    expect(() => conformalQuantile([1], 10_000)).toThrow(RangeError);
  });
});

describe('promise identity and signatures', () => {
  async function fresh() {
    const issued = issueClearBand({
      cluster: 'localnet', program: 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ', cross: 'CrossAddr1', openTs: 1000, closeTs: 2000, revealEndTs: 2000, now: 1500, ordersCommitted: 2, book: CROSSING, history: [],
    });
    if (!issued) throw new Error('expected a promise');
    const signer = await generateKeyPairSigner();
    return { issued, signer, signed: await signPromiseWith(issued.promise, signer) };
  }

  it('a signed promise verifies; the id is the hash of the body', async () => {
    const { signed, signer } = await fresh();
    expect(verifyPromiseId(signed.promise)).toBe(true);
    expect(await verifySigned(signed, signer.address)).toEqual({ ok: true });
  });

  it('any change to the body after signing is caught as an id mismatch', async () => {
    const { signed } = await fresh();
    const forged = { ...signed, promise: { ...signed.promise, claim: { ...signed.promise.claim, hiTick: signed.promise.claim.hiTick + 1 } } };
    expect(await verifySigned(forged)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
  });

  it('re-hashing a tampered body still fails: the signature is bound to the original id', async () => {
    const { signed } = await fresh();
    const body = { ...signed.promise, claim: { ...signed.promise.claim, hiTick: signed.promise.claim.hiTick + 1 } };
    const { id: _old, ...rest } = body;
    const rehashed = buildPromise(rest);
    expect(await verifySigned({ ...signed, promise: rehashed })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('a signature from another key, or a flipped bit, fails', async () => {
    const { signed } = await fresh();
    const other = await generateKeyPairSigner();
    expect(await verifySigned({ ...signed, signer: other.address })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const flipped = signed.signature.slice(0, -1) + (signed.signature.endsWith('0') ? '1' : '0');
    expect(await verifySigned({ ...signed, signature: flipped })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await verifySigned({ ...signed, signature: 'zz' })).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('an expected signer is enforced before anything else', async () => {
    const { signed } = await fresh();
    const other = await generateKeyPairSigner();
    expect(await verifySigned(signed, other.address)).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
  });

  it('a signature over the bare id (no domain prefix) is not accepted', async () => {
    const { signed, signer } = await fresh();
    const { signBytes } = await import('@solana/kit');
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    const bare = bytesToHex(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(signed.promise.id)));
    expect(await verifySigned({ ...signed, signature: bare })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses to build a calibrated promise that claims no coverage, or a provisional one that claims one', async () => {
    const { issued } = await fresh();
    const { id: _id, ...body } = issued.promise;
    expect(() => buildPromise({ ...body, claim: { ...body.claim, status: 'CALIBRATED', nominalCoverageBps: null } })).toThrow(/coverage/);
    expect(() => buildPromise({ ...body, claim: { ...body.claim, nominalCoverageBps: 9_000 } })).toThrow(/no coverage/);
    expect(() => buildPromise({ ...body, claim: { ...body.claim, reason: null } })).toThrow(/says why/);
    expect(() => buildPromise({ ...body, claim: { ...body.claim, loTick: body.claim.pointTick + 1 } })).toThrow(/lo ≤ point ≤ hi/);
    expect(() => buildPromise({ ...body, claim: { ...body.claim, hiTick: 400 } })).toThrow(/grid/);
  });
});

describe('issuing', () => {
  const base = { cluster: 'localnet', program: 'P', cross: 'C', openTs: 1000, closeTs: 2000, revealEndTs: 2000, ordersCommitted: 2, book: CROSSING, history: [] as GradedSample[] };

  it('point is the clearing tick of the open book, from the independent reference', () => {
    // buy 5 @ tick 10, sell 5 @ tick 6: every tick 6..10 trades 5; the lowest wins
    expect(indicativeTick(CROSSING)).toBe(6);
    const p = issueClearBand({ ...base, now: 1500 });
    expect(p?.promise.claim.pointTick).toBe(6);
  });

  it('says nothing outside the call window or when nothing crosses', () => {
    expect(issueClearBand({ ...base, now: 999 })).toBeNull();
    expect(issueClearBand({ ...base, now: 2000 })).toBeNull();
    expect(issueClearBand({ ...base, now: 1500, book: book([[10, 5n, 0n]]) })).toBeNull();
    expect(issueClearBand({ ...base, now: 1500, book: book([]) })).toBeNull();
  });

  it('starts provisional: no coverage claimed, the band is the bare point, and it says why', () => {
    const p = issueClearBand({ ...base, now: 1500 })!;
    expect(p.promise.claim).toMatchObject({ status: 'PROVISIONAL', nominalCoverageBps: null, loTick: 6, hiTick: 6 });
    expect(p.promise.claim.reason).toContain('NEED_9_SAMPLES');
  });

  it('is deterministic: same inputs, same id', () => {
    expect(issueClearBand({ ...base, now: 1500 })!.promise.id).toBe(issueClearBand({ ...base, now: 1500 })!.promise.id);
    expect(issueClearBand({ ...base, now: 1501 })!.promise.id).not.toBe(issueClearBand({ ...base, now: 1500 })!.promise.id);
  });

  it('buckets the call window in thirds', () => {
    expect(bucketOf(1000, 1000, 2000)).toBe(0);
    expect(bucketOf(1333, 1000, 2000)).toBe(0);
    expect(bucketOf(1334, 1000, 2000)).toBe(1);
    expect(bucketOf(1666, 1000, 2000)).toBe(1);
    expect(bucketOf(1667, 1000, 2000)).toBe(2);
    expect(bucketOf(1999, 1000, 2000)).toBe(2);
    expect(() => bucketOf(1, 5, 5)).toThrow();
  });

  it('the published inputs hash to inputsHash, so anyone can recompute the point', () => {
    const p = issueClearBand({ ...base, now: 1500 })!;
    expect(hashJcs(p.inputs)).toBe(p.promise.inputsHash);
  });
});

describe('grading', () => {
  const p = issueClearBand({ cluster: 'localnet', program: 'P', cross: 'C', openTs: 1000, closeTs: 2000, revealEndTs: 2000, now: 1500, ordersCommitted: 2, book: CROSSING, history: [] })!.promise;
  it('a provisional point is SCORED with its error, never HIT or MISS', () => {
    expect(gradeClearBand(p, { kind: 'CLEARED', priceTick: 9, atS: 2100 }, 2200)).toMatchObject({ status: 'SCORED', errorTicks: 3, intervalScoreTicks: null });
  });
  it('a pending cross is UNRESOLVED, and later still says the deadline passed', () => {
    expect(gradeClearBand(p, { kind: 'PENDING' }, 1600)).toMatchObject({ status: 'UNRESOLVED', reason: 'HORIZON_NOT_ELAPSED' });
    expect(gradeClearBand(p, { kind: 'PENDING' }, p.deadline + 1)).toMatchObject({ status: 'UNRESOLVED', reason: 'DEADLINE_PASSED_WITHOUT_OUTCOME' });
  });
  it('a cross that never printed voids the promise with the reason', () => {
    expect(gradeClearBand(p, { kind: 'NO_PRINT', reason: 'BelowMinimumVolume', atS: 2100 }, 2200)).toMatchObject({ status: 'VOID', reason: 'NO_PRINT:BelowMinimumVolume' });
  });
  it('a calibrated band is HIT inside and MISS outside, with an interval score', () => {
    const r = rng(11);
    const history: GradedSample[] = Array.from({ length: 600 }, (_, i) => ({
      promiseId: `h${String(i).padStart(4, '0')}`, cross: `x${i}`, bucket: 2, issuedAt: 100_000 + i * 600, outcomeAt: 100_000 + i * 600 + 300,
      errorTicks: Math.floor(Math.log(1 - r()) / Math.log(0.6)),
    }));
    // now = 1900 of [1000, 2000) is bucket 2 (the late third)
    const cal = issueClearBand({ cluster: 'localnet', program: 'P', cross: 'C', openTs: 1000, closeTs: 2000, revealEndTs: 2000, now: 1900, ordersCommitted: 2, book: CROSSING, history })!;
    const c = cal.promise.claim;
    expect(c.status).toBe('CALIBRATED');
    expect(c.nominalCoverageBps).toBe(9_000);
    expect(c.reason).toBeNull();
    const q = c.calibration.quantileTicks!;
    expect(q).toBeGreaterThanOrEqual(3);
    expect([c.loTick, c.hiTick]).toEqual([Math.max(0, c.pointTick - q), Math.min(39, c.pointTick + q)]);
    expect(gradeClearBand(cal.promise, { kind: 'CLEARED', priceTick: c.pointTick, atS: 2100 }, 2200).status).toBe('HIT');
    expect(gradeClearBand(cal.promise, { kind: 'CLEARED', priceTick: c.hiTick, atS: 2100 }, 2200).status).toBe('HIT');
    const g = gradeClearBand(cal.promise, { kind: 'CLEARED', priceTick: c.hiTick + 2, atS: 2100 }, 2200);
    expect(g.status).toBe('MISS');
    expect(g.errorTicks).toBe(c.hiTick + 2 - c.pointTick);
    // width + (2/α)·shortfall with α = 10%: (hi − lo) + 20 × 2
    expect(g.intervalScoreTicks).toBe(c.hiTick - c.loTick + 40);
  });

  it('a band near the edge of the grid is clipped to it, never extended past it', () => {
    const r = rng(12);
    const history: GradedSample[] = Array.from({ length: 600 }, (_, i) => ({
      promiseId: `h${String(i).padStart(4, '0')}`, cross: `x${i}`, bucket: 2, issuedAt: 100_000 + i * 600, outcomeAt: 100_000 + i * 600 + 300,
      errorTicks: 5 + Math.floor(r() * 3),
    }));
    const edge = book([[2, 5n, 0n], [0, 0n, 5n]]);
    const p = issueClearBand({ cluster: 'localnet', program: 'P', cross: 'C', openTs: 1000, closeTs: 2000, revealEndTs: 2000, now: 1900, ordersCommitted: 2, book: edge, history })!;
    expect(p.promise.claim.status).toBe('CALIBRATED');
    expect(p.promise.claim.loTick).toBe(0);
    expect(p.promise.claim.hiTick).toBe(p.promise.claim.pointTick + p.promise.claim.calibration.quantileTicks!);
  });
});

describe('calibration is earned, tested prequentially and withdrawn when it fails', () => {
  const policy = { ...DEFAULT_POLICY, minCalibrationSamples: 30, minHeldOutSamples: 20, minDistinctDays: 2 };
  const day = 86_400;

  function stream(n: number, draw: (i: number) => number, spacing = 1_000): GradedSample[] {
    return Array.from({ length: n }, (_, i) => ({ promiseId: `p${String(i).padStart(5, '0')}`, cross: `x${i}`, bucket: 1, issuedAt: 10_000 + i * spacing, outcomeAt: 10_000 + i * spacing + spacing / 2, errorTicks: draw(i) }));
  }

  it('a stationary stream reaches CALIBRATED with measured coverage near nominal', () => {
    const r = rng(1);
    // discrete errors with a long tail: P(err = k) ∝ 0.6^k
    const draw = () => Math.floor(Math.log(1 - r()) / Math.log(0.6));
    const s = stream(1500, draw).map((x, i) => ({ ...x, outcomeAt: x.outcomeAt + (i > 700 ? day * 2 : 0) }));
    const c = calibrateCell(1, s, policy);
    expect(c.status).toBe('CALIBRATED');
    expect(c.prequential.n).toBeGreaterThan(1000);
    expect(c.prequential.coverage).toBeGreaterThan(0.88);
    expect(c.prequential.coverage).toBeLessThan(0.97); // whole-tick scores make the quantile conservative, never short
    expect(c.quantileTicks).not.toBeNull();
  });

  it('too few samples: provisional with the count in the reason, and no band at all below the bounded minimum', () => {
    const c = calibrateCell(1, stream(5, () => 1), policy);
    expect(c.status).toBe('PROVISIONAL');
    expect(c.quantileTicks).toBeNull();
    expect(c.reason).toMatch(/NEED_9_SAMPLES.*have 5/);
    expect(c.reason).toMatch(/SAMPLES 5<30/);
  });

  it('enough samples on one day is still provisional: the regime has not been seen to change', () => {
    const r = rng(2);
    const c = calibrateCell(1, stream(200, () => Math.floor(r() * 4), 100), policy);
    expect(c.reason).toMatch(/DISTINCT_DAYS 1<2/);
    expect(c.status).toBe('PROVISIONAL');
  });

  it('a regime change is detected: errors grow, prequential coverage collapses, the cell loses CALIBRATED', () => {
    const r = rng(3);
    const calm = () => Math.floor(r() * 3);
    const wild = () => 3 + Math.floor(r() * 12);
    const s = stream(400, (i) => (i < 200 ? calm() : wild())).map((x, i) => ({ ...x, outcomeAt: x.outcomeAt + (i % 2 ? day : 0) }));
    const c = calibrateCell(1, s, policy);
    expect(c.status).toBe('PROVISIONAL');
    expect(c.reason).toMatch(/COVERAGE_BELOW_NOMINAL/);
    expect(c.prequential.coverage).toBeLessThan(0.85);
  });

  it('prequential never uses an outcome that was not yet known when the promise was issued', () => {
    // Every sample is issued before any outcome arrives, so no sample has history and none is tested.
    const s: GradedSample[] = Array.from({ length: 50 }, (_, i) => ({ promiseId: `q${i}`, cross: `x${i}`, bucket: 1, issuedAt: 100 + i, outcomeAt: 10_000, errorTicks: i }));
    expect(prequential(s, 9_000).n).toBe(0);
  });

  it('keeps one promise per cross per bucket: the last one issued in the bucket', () => {
    const rows = [
      { cross: 'a', bucket: 0, issuedAt: 1 },
      { cross: 'a', bucket: 0, issuedAt: 5 },
      { cross: 'a', bucket: 1, issuedAt: 3 },
      { cross: 'b', bucket: 0, issuedAt: 2 },
    ];
    expect(lastPerCrossBucket(rows).sort((x, y) => x.issuedAt - y.issuedAt)).toEqual([
      { cross: 'b', bucket: 0, issuedAt: 2 },
      { cross: 'a', bucket: 1, issuedAt: 3 },
      { cross: 'a', bucket: 0, issuedAt: 5 },
    ]);
  });

  it('the samples hash changes when any sample changes', () => {
    const s = stream(20, () => 1);
    const h = calibrateCell(1, s, policy).samplesHash;
    expect(calibrateCell(1, s.map((x, i) => (i === 3 ? { ...x, errorTicks: 2 } : x)), policy).samplesHash).not.toBe(h);
    expect(calibrateCell(1, [...s].reverse(), policy).samplesHash).toBe(h); // order independent
  });
});

describe('accuracy report', () => {
  it('every promise lands in exactly one status, so the totals partition the issued count', () => {
    const mk = (i: number, bucket: number, grade: Parameters<typeof report>[0][number]['grade']['status'], err: number | null): GradedRecord => {
      const promise = issueClearBand({ cluster: 'localnet', program: 'P', cross: `C${i}`, openTs: 0, closeTs: 3_000, revealEndTs: 3_000, now: 500 + bucket * 1_000, ordersCommitted: 2, book: CROSSING, history: [] })!.promise;
      return { promise, grade: { promiseId: promise.id, status: grade, reason: null, outcomeTick: err === null ? null : 6 + err, errorTicks: err, intervalScoreTicks: null, gradedAt: 9_999 } };
    };
    const rs = [mk(1, 0, 'SCORED', 1), mk(2, 0, 'SCORED', 3), mk(3, 1, 'VOID', null), mk(4, 2, 'UNRESOLVED', null), mk(5, 2, 'HIT', 0), mk(6, 2, 'MISS', 5)];
    const rep = report(rs, samplesOf(rs, () => 9_000));
    expect(rep.buckets.reduce((a, b) => a + b.hit + b.miss + b.scored + b.void + b.unresolved, 0)).toBe(rs.length);
    expect(rep.totals).toMatchObject({ issued: 6, crosses: 6, graded: 4, unresolved: 1, void: 1 });
    expect(rep.buckets[0]).toMatchObject({ scored: 2, coverage: null, meanAbsErrorTicks: 2, medianAbsErrorTicks: 2 });
    expect(rep.buckets[2]).toMatchObject({ hit: 1, miss: 1, coverage: 0.5 });
    expect(rep.buckets[2]!.coverageWilsonLo!).toBeLessThan(0.5);
  });
});
