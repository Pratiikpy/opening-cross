// The promiser's three rounds. Each is a plain function of its dependencies so the tests drive the
// real code with a controllable clock and chain, and the process only wires in the real ones.
//
//   issueRound  — for every open-book cross inside its call window, sign a CLEAR_BAND promise.
//   gradeRound  — for every promise whose cross has settled, read the outcome and grade it.
//   anchorRound — fold the ids not yet anchored into a Merkle root and write it to the chain.
import type { Address, KeyPairSigner } from '@solana/kit';
import { type Cross, CrossState, Disclosure, getCrossDecoder } from '@opening-cross/cross-core-client';
import { type AccountReader, loadBook } from '@opening-cross/router';
import {
  type BookSnapshot,
  type Outcome,
  type Policy,
  DEFAULT_POLICY,
  gradeClearBand,
  issueClearBand,
  memoText,
  merkleRoot,
  signPromiseWith,
} from '@opening-cross/promises';
import type pg from 'pg';
import { anchorFor, clearedAt, insertPromise, latestForCross, recordAnchor, samples, ungraded, unanchoredIds, upsertGrade } from './store.js';

export interface Deps {
  readonly db: pg.Pool;
  readonly cluster: string;
  readonly program: string;
  readonly signer: KeyPairSigner;
  readonly read: AccountReader;
  /** Cluster time, unix seconds. */
  readonly now: () => Promise<number>;
  readonly policy?: Policy;
  /** Does not reissue for the same cross and bucket more often than this unless the claim changed. */
  readonly minReissueSeconds?: number;
}

const tickOf = (c: Cross, price: bigint): number => Number((price - c.minPrice) / c.tick);

async function readCross(read: AccountReader, address: string): Promise<Cross | null> {
  const a = await read(address as Address);
  return a ? getCrossDecoder().decode(a.data) : null;
}

export interface IssueReport {
  readonly issued: string[];
  readonly skipped: { readonly cross: string; readonly reason: string }[];
}

export async function issueRound(d: Deps): Promise<IssueReport> {
  const report: { issued: string[]; skipped: { cross: string; reason: string }[] } = { issued: [], skipped: [] };
  const policy = d.policy ?? DEFAULT_POLICY;
  const now = await d.now();
  const { rows } = await d.db.query(`SELECT address FROM crosses WHERE state = 'Live' ORDER BY created_slot`);
  const history = await samples(d.db, d.cluster);
  for (const { address } of rows as { address: string }[]) {
    const c = await readCross(d.read, address);
    if (!c) {
      report.skipped.push({ cross: address, reason: 'NOT_ON_CHAIN' });
      continue;
    }
    if (c.state !== CrossState.Live) continue;
    if (c.disclosure !== Disclosure.Open) {
      report.skipped.push({ cross: address, reason: 'SEALED_BOOK_HAS_NO_INDICATIVE_PRICE' });
      continue;
    }
    if (now < Number(c.openTs) || now >= Number(c.closeTs)) continue;
    const levels = await loadBook(d.read, address as Address, c);
    if (typeof levels === 'string') {
      report.skipped.push({ cross: address, reason: levels });
      continue;
    }
    const grid = { minPrice: c.minPrice.toString(), tick: c.tick.toString(), ticks: c.ticks, priceScale: c.priceScale.toString() };
    const book: BookSnapshot = { grid, buy: levels.buy, sell: levels.sell, referenceTick: c.referencePrice.__option === 'Some' ? tickOf(c, c.referencePrice.value) : null };
    const issued = issueClearBand({
      cluster: d.cluster, program: d.program, cross: address, openTs: Number(c.openTs), closeTs: Number(c.closeTs), revealEndTs: Number(c.revealEndTs), now, ordersCommitted: c.ordersTotal, book, history, policy,
    });
    if (!issued) {
      report.skipped.push({ cross: address, reason: 'NOTHING_CROSSES_YET' });
      continue;
    }
    // Do not sign the same statement again and again: reissue when the claim changed or a minute passed.
    const last = await latestForCross(d.db, address);
    const lc = last?.signed.promise;
    const same = lc && lc.subject.bucket === issued.promise.subject.bucket && lc.claim.pointTick === issued.promise.claim.pointTick && lc.claim.loTick === issued.promise.claim.loTick && lc.claim.hiTick === issued.promise.claim.hiTick && lc.subject.ordersCommitted === issued.promise.subject.ordersCommitted;
    if (same && now - lc.issuedAt < (d.minReissueSeconds ?? 60)) {
      report.skipped.push({ cross: address, reason: 'UNCHANGED' });
      continue;
    }
    const signed = await signPromiseWith(issued.promise, d.signer);
    if (await insertPromise(d.db, d.cluster, signed, issued.inputs)) report.issued.push(issued.promise.id);
  }
  return report;
}

export interface GradeReport {
  readonly graded: number;
  readonly stillPending: number;
}

export async function gradeRound(d: Deps): Promise<GradeReport> {
  const now = await d.now();
  let graded = 0;
  let pending = 0;
  const open = await ungraded(d.db, d.cluster);
  const byCross = new Map<string, typeof open>();
  for (const p of open) byCross.set(p.subject.cross, [...(byCross.get(p.subject.cross) ?? []), p]);
  for (const [address, promises] of byCross) {
    const c = await readCross(d.read, address);
    let outcome: Outcome = { kind: 'PENDING' };
    let outcomeAt: number | null = null;
    if (c && c.state !== CrossState.Live) {
      outcomeAt = (await clearedAt(d.db, address)) ?? now;
      if (c.clearing.__option === 'Some') outcome = { kind: 'CLEARED', priceTick: tickOf(c, c.clearing.value.price), atS: outcomeAt };
      else outcome = { kind: 'NO_PRINT', reason: c.noPrintReason.__option === 'Some' ? String(c.noPrintReason.value) : 'NoCross', atS: outcomeAt };
    }
    for (const p of promises) {
      const g = gradeClearBand(p, outcome, now);
      await upsertGrade(d.db, g, g.status === 'UNRESOLVED' ? null : outcomeAt);
      if (g.status === 'UNRESOLVED') pending++;
      else graded++;
    }
  }
  return { graded, stillPending: pending };
}

export interface AnchorReport {
  readonly anchored: number;
  readonly signature: string | null;
}

/** `send` writes the memo and returns the transaction's signature, slot and block time. */
export async function anchorRound(d: Deps, send: (memo: string) => Promise<{ signature: string; slot: number | null; blockTime: number | null }>): Promise<AnchorReport> {
  const ids = await unanchoredIds(d.db, d.cluster);
  if (ids.length === 0) return { anchored: 0, signature: null };
  const digest = { root: merkleRoot(ids), count: new Set(ids).size };
  const tx = await send(memoText(digest));
  await recordAnchor(d.db, d.cluster, digest, ids, tx);
  return { anchored: digest.count, signature: tx.signature };
}

export { anchorFor };
