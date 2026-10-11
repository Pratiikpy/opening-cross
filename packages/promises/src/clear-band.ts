// CLEAR_BAND promises: "this cross will clear inside these grid ticks". The point is the price the
// open book would clear at if the call closed now, computed with the independent reference
// implementation of ADR-0003. The band comes from the cell's graded history, or is the bare point
// while the cell is PROVISIONAL.
import { referenceClear } from '@opening-cross/verifier';
import { type CellCalibration, type GradedSample, calibrateCell } from './conformal.js';
import { type Json, hashJcs } from './jcs.js';
import { intervalScore } from './metrics.js';
import { buildPromise } from './promise.js';
import { DEFAULT_POLICY, type Grade, type GridRef, type OpeningCrossPromise, PROMISE_SCHEMA, type Policy, type PromiseBody } from './types.js';

export const MODEL_ID = 'indicative-clearing/adr-0003+split-conformal/v1';

export interface BookSnapshot {
  readonly grid: GridRef;
  /** Resting quantity per tick, base atoms. */
  readonly buy: readonly bigint[];
  readonly sell: readonly bigint[];
  /** Reference price as a grid tick, when the cross has one. */
  readonly referenceTick: number | null;
}

export interface IssueInput {
  readonly cluster: string;
  readonly program: string;
  readonly cross: string;
  readonly openTs: number;
  readonly closeTs: number;
  /** Order-entry and reveal end; the outcome cannot exist before it. */
  readonly revealEndTs: number;
  readonly now: number;
  readonly ordersCommitted: number;
  readonly book: BookSnapshot;
  /** Every graded sample so far, used to fit the cell. */
  readonly history: readonly GradedSample[];
  readonly policy?: Policy;
  /** Grace after the reveal window before an unsettled cross is reported UNRESOLVED, seconds. */
  readonly graceSeconds?: number;
}

export interface Issued {
  readonly promise: OpeningCrossPromise;
  /** The canonical inputs behind `inputsHash`; publish them so anyone can recompute the point. */
  readonly inputs: Json;
  readonly cell: CellCalibration;
}

/** Which third of the call window `now` falls in, by the policy's boundaries. */
export function bucketOf(now: number, openTs: number, closeTs: number, policy: Policy = DEFAULT_POLICY): number {
  const span = closeTs - openTs;
  if (span <= 0) throw new RangeError('the call window must have positive length');
  const bps = Math.min(9_999, Math.max(0, Math.floor(((now - openTs) * 10_000) / span)));
  let b = 0;
  for (const bound of policy.bucketBoundsBps) if (bps >= bound) b++;
  return b;
}

export const policyHash = (p: Policy): string => hashJcs(p as unknown as Json);

/** The tick the open book would clear at, or null when it would not cross at all. */
export function indicativeTick(book: BookSnapshot): number | null {
  const min = BigInt(book.grid.minPrice);
  const tick = BigInt(book.grid.tick);
  const orders = [];
  for (let i = 0; i < book.grid.ticks; i++) {
    const price = min + BigInt(i) * tick;
    if ((book.buy[i] ?? 0n) > 0n) orders.push({ side: 'buy' as const, price, quantity: book.buy[i]! });
    if ((book.sell[i] ?? 0n) > 0n) orders.push({ side: 'sell' as const, price, quantity: book.sell[i]! });
  }
  const ref = book.referenceTick === null ? null : min + BigInt(book.referenceTick) * tick;
  const r = referenceClear(orders, { min, tick, ticks: book.grid.ticks }, ref);
  return r ? Number((r.price - min) / tick) : null;
}

/**
 * Issues the promise for `now`, or returns null when there is nothing honest to say: the call is
 * not open, or the book does not cross.
 */
export function issueClearBand(input: IssueInput): Issued | null {
  const policy = input.policy ?? DEFAULT_POLICY;
  if (input.now < input.openTs || input.now >= input.closeTs) return null;
  const point = indicativeTick(input.book);
  if (point === null) return null;
  const bucket = bucketOf(input.now, input.openTs, input.closeTs, policy);
  const cell = calibrateCell(bucket, input.history, policy);
  const last = input.book.grid.ticks - 1;
  const half = cell.status === 'CALIBRATED' ? (cell.quantileTicks as number) : 0;
  const lo = Math.max(0, point - half);
  const hi = Math.min(last, point + half);

  const inputs: Json = {
    grid: input.book.grid as unknown as Json,
    referenceTick: input.book.referenceTick,
    levels: input.book.buy
      .map((b, i) => [i, b.toString(), (input.book.sell[i] ?? 0n).toString()] as [number, string, string])
      .filter(([, b, s]) => b !== '0' || s !== '0'),
  };
  const body: PromiseBody = {
    schema: PROMISE_SCHEMA,
    kind: 'CLEAR_BAND',
    cluster: input.cluster,
    program: input.program,
    subject: { cross: input.cross, bucket, grid: input.book.grid, ordersCommitted: input.ordersCommitted },
    issuedAt: input.now,
    deadline: input.revealEndTs + (input.graceSeconds ?? 7 * 86_400),
    claim: {
      pointTick: point,
      loTick: lo,
      hiTick: hi,
      nominalCoverageBps: cell.status === 'CALIBRATED' ? policy.nominalCoverageBps : null,
      status: cell.status,
      reason: cell.reason,
      calibration: { cell: cell.cell, n: cell.n, crosses: cell.crosses, quantileTicks: cell.quantileTicks, samplesHash: cell.samplesHash },
    },
    outcomeSpec: { source: 'cross_core.Cross.clearing.price', rule: 'HIT_IN_TICKS' },
    inputsHash: hashJcs(inputs),
    modelId: MODEL_ID,
    policyHash: policyHash(policy),
  };
  return { promise: buildPromise(body), inputs, cell };
}

export type Outcome =
  | { readonly kind: 'CLEARED'; readonly priceTick: number; readonly atS: number }
  | { readonly kind: 'NO_PRINT'; readonly reason: string; readonly atS: number }
  | { readonly kind: 'PENDING' };

/** Grades one promise. Pure: the same promise and outcome always give the same grade. */
export function gradeClearBand(p: OpeningCrossPromise, outcome: Outcome, now: number): Grade {
  const base = { promiseId: p.id, gradedAt: now };
  if (outcome.kind === 'PENDING') {
    const late = now > p.deadline;
    return { ...base, status: 'UNRESOLVED', reason: late ? 'DEADLINE_PASSED_WITHOUT_OUTCOME' : 'HORIZON_NOT_ELAPSED', outcomeTick: null, errorTicks: null, intervalScoreTicks: null };
  }
  if (outcome.kind === 'NO_PRINT') {
    return { ...base, status: 'VOID', reason: `NO_PRINT:${outcome.reason}`, outcomeTick: null, errorTicks: null, intervalScoreTicks: null };
  }
  const c = p.claim;
  const error = Math.abs(outcome.priceTick - c.pointTick);
  if (c.nominalCoverageBps === null) {
    return { ...base, status: 'SCORED', reason: null, outcomeTick: outcome.priceTick, errorTicks: error, intervalScoreTicks: null };
  }
  const hit = outcome.priceTick >= c.loTick && outcome.priceTick <= c.hiTick;
  return {
    ...base,
    status: hit ? 'HIT' : 'MISS',
    reason: null,
    outcomeTick: outcome.priceTick,
    errorTicks: error,
    intervalScoreTicks: intervalScore(c.loTick, c.hiTick, outcome.priceTick, 10_000 - c.nominalCoverageBps),
  };
}
