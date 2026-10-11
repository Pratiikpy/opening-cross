// Signed, graded promises end to end (ADR-0015). Real crosses on LiteSVM, the real indexer into
// Postgres, the real promiser rounds: every promise is signed, verified by a stranger's code path,
// graded against the clearing price the program itself recorded, anchored with a Merkle proof, and
// reported with its measured coverage. The calibration gates are scaled down so a few dozen crosses
// can exercise the whole path; their statistical behaviour is tested in packages/promises.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, AccountRole, generateKeyPairSigner } from '@solana/kit';
import { OrderSide, SupplyMode, CROSS_CORE_PROGRAM_ADDRESS, Disclosure } from '@opening-cross/sdk';
import { ingestTransaction } from '@opening-cross/indexer';
import {
  type Deps,
  anchorFor,
  anchorRound,
  getInputs,
  getPromise,
  gradeRound,
  issueRound,
  records,
  samples,
} from '@opening-cross/promiser';
import {
  DEFAULT_POLICY,
  MEMO_PROGRAM,
  calibrateCell,
  hashJcs,
  indicativeTick,
  memoText,
  merkleRoot,
  parseMemo,
  report,
  verifyProof,
  verifySigned,
} from '@opening-cross/promises';
import { buildServer } from '../../../services/api/src/server.js';
import { freshDb } from '../src/db.js';
import { World } from '../src/world.js';

const DAY = 86_400n;
const BASE = 1_800_000_000n;
const POLICY = { ...DEFAULT_POLICY, nominalCoverageBps: 8_000, minCalibrationSamples: 6, minDistinctDays: 2, minHeldOutSamples: 3 };

describe.skipIf(!process.env.DATABASE_URL)('promiser', () => {
  async function rig() {
    const { db } = await freshDb();
    const w = await World.create();
    const signer = await generateKeyPairSigner();
    let ingested = 0;
    const sync = async () => {
      for (; ingested < w.h.landed.length; ingested++) await ingestTransaction(db, w.h.landed[ingested]!);
    };
    const deps: Deps = {
      db,
      cluster: 'localnet',
      program: CROSS_CORE_PROGRAM_ADDRESS,
      signer,
      read: async (a: Address) => {
        const x = w.h.svm.getAccount(a);
        return x.exists ? { data: x.data, owner: x.programAddress } : null;
      },
      now: async () => Number(w.h.svm.getClock().unixTimestamp),
      policy: POLICY,
      minReissueSeconds: 0,
    };
    return { db, w, signer, sync, deps };
  }

  it('signs a band at each stage of a call, grades it against the on-chain price, and anchors it', async () => {
    const { db, w, signer, sync, deps } = await rig();
    const cross = await w.newCross({ disclosure: Disclosure.Open, openTs: BASE, closeTs: BASE + 300n });
    const seller = await w.trader(0n, 5_000_000_000n);
    const b1 = await w.trader(20_000_000_000n);
    const b2 = await w.trader(20_000_000_000n);
    const b3 = await w.trader(20_000_000_000n);
    const orders = [await w.place(cross, seller, OrderSide.Sell, 1_300_000n, 3_000_000_000n), await w.place(cross, b1, OrderSide.Buy, 1_800_000n, 1_000_000_000n)];
    await sync();

    // Bucket 0: only a small bid against the offer.
    w.h.setTime(BASE + 50n);
    const r0 = await issueRound(deps);
    expect(r0.issued).toHaveLength(1);
    // Nothing changed → nothing new to sign (minReissue is 0, but the claim is identical and re-signing adds nothing)
    expect((await issueRound({ ...deps, minReissueSeconds: 60 })).issued).toHaveLength(0);

    // Bucket 1: a bigger bid moves the clearing price up.
    w.h.setTime(BASE + 120n);
    orders.push(await w.place(cross, b2, OrderSide.Buy, 2_200_000n, 2_000_000_000n));
    await sync();
    const r1 = await issueRound(deps);
    expect(r1.issued).toHaveLength(1);

    // Bucket 2: a last bid after the checkpoint changes the outcome again.
    w.h.setTime(BASE + 250n);
    const r2 = await issueRound(deps);
    expect(r2.issued).toHaveLength(1);
    w.h.setTime(BASE + 280n);
    orders.push(await w.place(cross, b3, OrderSide.Buy, 2_900_000n, 2_500_000_000n));
    await sync();

    // Every promise is signed by the promiser's key, verifies, and publishes the book it was computed from.
    for (const id of [...r0.issued, ...r1.issued, ...r2.issued]) {
      const row = (await getPromise(db, id))!;
      expect(await verifySigned(row.signed, signer.address)).toEqual({ ok: true });
      expect(row.signed.promise.claim.status).toBe('PROVISIONAL');
      expect(row.grade).toBeNull();
      const inputs = (await getInputs(db, id))!;
      expect(hashJcs(inputs)).toBe(row.signed.promise.inputsHash);
    }

    // A pending cross is not graded; it is reported UNRESOLVED with the reason.
    const early = await gradeRound(deps);
    expect(early).toEqual({ graded: 0, stillPending: 3 });
    expect((await getPromise(db, r0.issued[0]!))!.grade).toMatchObject({ status: 'UNRESOLVED', reason: 'HORIZON_NOT_ELAPSED' });

    // Settle; the grade comes from the cross account the program wrote.
    const settled = await w.settle(cross);
    await sync();
    const clearing = settled.data.clearing;
    if (clearing.__option !== 'Some') throw new Error('the cross should have printed');
    const finalTick = Number((clearing.value.price - settled.data.minPrice) / settled.data.tick);
    const done = await gradeRound(deps);
    expect(done).toEqual({ graded: 3, stillPending: 0 });
    for (const id of [...r0.issued, ...r1.issued, ...r2.issued]) {
      const row = (await getPromise(db, id))!;
      expect(row.grade).toMatchObject({ status: 'SCORED', outcomeTick: finalTick });
      expect(row.grade!.errorTicks).toBe(Math.abs(finalTick - row.signed.promise.claim.pointTick));
      expect(row.outcomeAt).toBe(Number(settled.data.revealEndTs) + 1);
    }
    // A final grade never changes: grading again leaves it as it was.
    await gradeRound(deps);
    expect((await getPromise(db, r0.issued[0]!))!.grade).toMatchObject({ status: 'SCORED', outcomeTick: finalTick });

    // The last bid landed after every band was signed and moved the price, so each band was wrong by the same distance,
    // and the error recorded is exactly that distance.
    const errs = await Promise.all([...r0.issued, ...r1.issued, ...r2.issued].map(async (id) => (await getPromise(db, id))!.grade!.errorTicks!));
    expect(new Set(errs).size).toBe(1);
    expect(errs[0]).toBeGreaterThan(0);

    // Anchor: the memo carries the Merkle root of the three ids; each has a proof that checks out.
    const memoSent: string[] = [];
    const anchor = await anchorRound(deps, async (memo) => {
      memoSent.push(memo);
      const ix: Instruction = { programAddress: MEMO_PROGRAM as Address, accounts: [{ address: w.admin.address, role: AccountRole.READONLY_SIGNER, signer: w.admin }], data: new TextEncoder().encode(memo) } as unknown as Instruction;
      await w.h.send([ix], w.admin);
      const t = w.h.landed.at(-1)!;
      return { signature: t.signature, slot: Number(t.slot), blockTime: Number(t.blockTime) };
    });
    expect(anchor.anchored).toBe(3);
    const ids = [...r0.issued, ...r1.issued, ...r2.issued];
    expect(parseMemo(memoSent[0]!)).toEqual({ root: merkleRoot(ids), count: 3 });
    expect(memoSent[0]).toBe(memoText({ root: merkleRoot(ids), count: 3 }));
    for (const id of ids) {
      const a = (await anchorFor(db, id))!;
      expect(verifyProof(id, a.proof, a.root)).toBe(true);
      // The memo really is on chain, in the transaction the anchor names, before any outcome existed? No: after.
      // Chain time bounds the promise from above: anchor time ≥ issuance.
      expect(a.blockTime!).toBeGreaterThanOrEqual((await getPromise(db, id))!.signed.promise.issuedAt);
    }
    // Nothing left to anchor.
    expect((await anchorRound(deps, async () => { throw new Error('must not send'); })).anchored).toBe(0);
  });

  it('never promises a sealed book, a book that does not cross, or a closed window', async () => {
    const { w, sync, deps } = await rig();
    const sealed = await w.newCross({ disclosure: Disclosure.Sealed, openTs: BASE, closeTs: BASE + 300n });
    const open = await w.newCross({ disclosure: Disclosure.Open, openTs: BASE, closeTs: BASE + 300n });
    const s = await w.trader(0n, 1_000_000_000n);
    await w.place(open, s, OrderSide.Sell, 1_300_000n, 1_000_000_000n);
    await sync();
    w.h.setTime(BASE + 50n);
    const r = await issueRound(deps);
    expect(r.issued).toHaveLength(0);
    expect(r.skipped).toContainEqual({ cross: sealed.address, reason: 'SEALED_BOOK_HAS_NO_INDICATIVE_PRICE' });
    expect(r.skipped).toContainEqual({ cross: open.address, reason: 'NOTHING_CROSSES_YET' });
    w.h.setTime(BASE + 301n);
    expect((await issueRound(deps)).issued).toHaveLength(0);
  });

  it('a cross that does not print voids its promises with the reason, and they stay counted', async () => {
    const { db, w, sync, deps } = await rig();
    const cross = await w.newCross({ disclosure: Disclosure.Open, openTs: BASE, closeTs: BASE + 300n, minMatched: 9_000_000_000_000n });
    const s = await w.trader(0n, 1_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    await w.place(cross, s, OrderSide.Sell, 1_300_000n, 1_000_000_000n);
    await w.place(cross, b, OrderSide.Buy, 1_800_000n, 1_000_000_000n);
    await sync();
    w.h.setTime(BASE + 50n);
    const r = await issueRound(deps);
    expect(r.issued).toHaveLength(1);
    await w.settle(cross);
    await sync();
    await gradeRound(deps);
    expect((await getPromise(db, r.issued[0]!))!.grade).toMatchObject({ status: 'VOID', reason: expect.stringContaining('NO_PRINT') });
    const { rows } = await records(db, 'localnet');
    const rep = report(rows, await samples(db, 'localnet'), POLICY);
    expect(rep.totals).toMatchObject({ issued: 1, void: 1, graded: 0 });
    expect(rep.buckets[0]).toMatchObject({ issued: 1, void: 1 });
  });

  it('many crosses: calibration is earned from graded history, reissues follow it, and the report partitions every promise', async () => {
    const { db, w, sync, deps } = await rig();
    const seller = await w.trader(0n, 400_000_000_000n);
    // One at a time: the harness expires the blockhash on every send, so concurrent sends would invalidate each other.
    const buyers = [];
    for (let k = 0; k < 4; k++) buyers.push(await w.trader(400_000_000_000n));
    const N = 16;
    const issuedClaims: { i: number; status: string; cell: string; reason: string | null }[] = [];
    for (let i = 0; i < N; i++) {
      const open = BASE + BigInt(i) * (DAY / 4n); // four crosses a day: the run spans several days
      const cross = await w.newCross({ disclosure: Disclosure.Open, openTs: open, closeTs: open + 300n });
      const sell = await w.place(cross, seller, OrderSide.Sell, 1_300_000n, 5_000_000_000n);
      void sell;
      await w.place(cross, buyers[0]!, OrderSide.Buy, 1_900_000n, 1_000_000_000n);
      await sync();
      w.h.setTime(open + 250n); // the late bucket
      const r = await issueRound(deps);
      expect(r.issued.length).toBeLessThanOrEqual(1);
      for (const id of r.issued) {
        const row = (await getPromise(db, id))!;
        issuedClaims.push({ i, status: row.signed.promise.claim.status, cell: row.signed.promise.claim.calibration.cell, reason: row.signed.promise.claim.reason });
        // What was sealed into the promise is exactly what the pure calibrator says about the history at that moment.
        const expected = calibrateCell(row.signed.promise.subject.bucket, await samples(db, 'localnet'), POLICY);
        expect(row.signed.promise.claim.status).toBe(expected.status);
        expect(row.signed.promise.claim.calibration.samplesHash).toBe(expected.samplesHash);
      }
      // A late bid after the checkpoint: its size varies with i so the final price differs from the point.
      w.h.setTime(open + 290n);
      await w.place(cross, buyers[1 + (i % 3)]!, OrderSide.Buy, BigInt(2_000_000 + 100_000 * (i % 7)), 4_000_000_000n);
      await sync();
      await w.settle(cross);
      await sync();
      await gradeRound(deps);
    }
    expect(issuedClaims).toHaveLength(N);
    expect(issuedClaims[0]!.status).toBe('PROVISIONAL');
    expect(issuedClaims[0]!.reason).toMatch(/NEED_.*_SAMPLES/);

    const { rows } = await records(db, 'localnet');
    const rep = report(rows, await samples(db, 'localnet'), POLICY);
    const b2 = rep.buckets[2]!;
    expect(b2.issued + rep.buckets[0]!.issued + rep.buckets[1]!.issued).toBe(N);
    expect(b2.hit + b2.miss + b2.scored + b2.void + b2.unresolved).toBe(b2.issued);
    expect(b2.calibration.n).toBe(N);
    expect(b2.calibration.crosses).toBe(N);
    // Provisional promises were graded as SCORED with their real error; calibrated ones as HIT or MISS.
    const statuses = new Set(rows.map((r) => r.grade.status));
    expect([...statuses].every((s) => ['SCORED', 'HIT', 'MISS'].includes(s))).toBe(true);
    const calibrated = issuedClaims.filter((c) => c.status === 'CALIBRATED').length;
    expect(b2.hit + b2.miss).toBe(calibrated);
  }, 180_000);

  it('the promises survive a stranger checking them with nothing but the document', async () => {
    const { db, w, signer, sync, deps } = await rig();
    const cross = await w.newCross({ disclosure: Disclosure.Open, openTs: BASE, closeTs: BASE + 300n });
    const s = await w.trader(0n, 2_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    await w.place(cross, s, OrderSide.Sell, 1_300_000n, 2_000_000_000n);
    await w.place(cross, b, OrderSide.Buy, 1_800_000n, 1_000_000_000n);
    await sync();
    w.h.setTime(BASE + 100n);
    const [id] = (await issueRound(deps)).issued;
    const signed = (await getPromise(db, id!))!.signed;
    // Tamper with the point: the id no longer matches.
    const forged = { ...signed, promise: { ...signed.promise, claim: { ...signed.promise.claim, pointTick: signed.promise.claim.pointTick + 1 } } };
    expect(await verifySigned(forged)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    // The published inputs reproduce the point with the independent reference.
    const inputs = (await getInputs(db, id!)) as { grid: { ticks: number; minPrice: string; tick: string; priceScale: string }; referenceTick: number | null; levels: [number, string, string][] };
    const buy = new Array<bigint>(inputs.grid.ticks).fill(0n);
    const sell = new Array<bigint>(inputs.grid.ticks).fill(0n);
    for (const [t, bq, sq] of inputs.levels) {
      buy[t] = BigInt(bq);
      sell[t] = BigInt(sq);
    }
    expect(indicativeTick({ grid: inputs.grid, buy, sell, referenceTick: inputs.referenceTick })).toBe(signed.promise.claim.pointTick);
    expect(signed.signer).toBe(signer.address);
    void SupplyMode;
  });

  it('the HTTP routes serve exactly what was signed, refuse junk, and say so when there is nothing', async () => {
    const { db, w, signer, sync, deps } = await rig();
    const cross = await w.newCross({ disclosure: Disclosure.Open, openTs: BASE, closeTs: BASE + 300n });
    const app = await buildServer({ db, account: async (a: Address) => { const x = w.h.svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; }, lifetime: async () => ({}) as never, network: 'localnet', promiseSigner: signer.address });
    const get = async (url: string) => app.inject({ method: 'GET', url });

    // Before any band: the routes say so rather than inventing one, and the record is empty but well formed.
    expect((await get(`/v1/crosses/${cross.address}/promise`)).statusCode).toBe(404);
    // A page can ask for the same thing without a failed request.
    const optional = await get(`/v1/crosses/${cross.address}/promise?optional=1`);
    expect(optional.statusCode).toBe(200);
    expect(optional.json().promise).toBeNull();
    const empty = (await get('/v1/accuracy')).json();
    expect(empty.totals).toEqual({ issued: 0, crosses: 0, graded: 0, unresolved: 0, void: 0 });
    expect(empty.buckets).toHaveLength(3);
    expect((await get('/v1/promises/signer')).json()).toMatchObject({ signer: signer.address, cluster: 'localnet' });

    const s = await w.trader(0n, 2_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    await w.place(cross, s, OrderSide.Sell, 1_300_000n, 2_000_000_000n);
    await w.place(cross, b, OrderSide.Buy, 1_800_000n, 1_000_000_000n);
    await sync();
    w.h.setTime(BASE + 100n);
    const [id] = (await issueRound(deps)).issued;

    const byCross = (await get(`/v1/crosses/${cross.address}/promise`)).json();
    expect(byCross.promise.id).toBe(id);
    expect(await verifySigned({ promise: byCross.promise, signer: byCross.signer, signature: byCross.signature }, signer.address)).toEqual({ ok: true });
    expect(byCross.grade).toBeNull();
    expect((await get(`/v1/promises/${id}`)).json().promise.id).toBe(id);
    const inputs = (await get(`/v1/promises/${id}/inputs`)).json();
    expect(hashJcs(inputs)).toBe(byCross.promise.inputsHash);

    // Junk and unknowns.
    for (const bad of ['nope', 'ABC', 'G'.repeat(64), 'a'.repeat(63)]) {
      expect((await get(`/v1/promises/${bad}`)).statusCode, bad).toBe(400);
      expect((await get(`/v1/promises/${bad}/inputs`)).statusCode, bad).toBe(400);
    }
    expect((await get(`/v1/promises/${'a'.repeat(64)}`)).statusCode).toBe(404);
    expect((await get(`/v1/promises/${'a'.repeat(64)}/inputs`)).statusCode).toBe(404);
    expect((await get('/v1/crosses/not-an-address/promise')).statusCode).toBe(400);

    // After settlement the grade and the accuracy record agree with the chain.
    const settled = await w.settle(cross);
    await sync();
    await gradeRound(deps);
    const clearing = settled.data.clearing;
    if (clearing.__option !== 'Some') throw new Error('should have cleared');
    const finalTick = Number((clearing.value.price - settled.data.minPrice) / settled.data.tick);
    const graded = (await get(`/v1/promises/${id}`)).json();
    expect(graded.grade).toMatchObject({ status: 'SCORED', outcomeTick: finalTick });
    const acc = (await get('/v1/accuracy')).json();
    expect(acc.totals).toMatchObject({ issued: 1, crosses: 1, graded: 1, unresolved: 0 });
    expect(acc.signer).toBe(signer.address);
  }, 60_000);
});
