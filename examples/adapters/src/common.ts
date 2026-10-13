// What every adapter shares: the shape of a plan, a grid around a reference price, and the way a plan is run.
//
// An adapter is an integrator: a program outside Opening Cross that decides when and how to open a cross for its own market
// and asks the API or the chain for the transaction. It never holds a key it was not given and never skips the protocol's
// own checks. A plan is a pure function of live facts, so it can be read, tested and argued with before anything is sent.
import { type CreateCrossRequest, type RpcClient, type UnsignedTransaction, dryRun, signSendConfirm } from '@opening-cross/client';
import type { Signer } from '@opening-cross/client';

export type Plan = {
  /** What the adapter would create. */
  readonly request: CreateCrossRequest;
  /** Plain sentences: what is being opened, why these numbers, what the participants get. */
  readonly explanation: readonly string[];
  /** Things a human should look at before sending. */
  readonly warnings: readonly string[];
};

export type Skip = { readonly action: 'wait'; readonly reason: string };

export class PlanError extends Error {
  override readonly name = 'PlanError';
}

/** A random 48-bit cross id, as the CLI picks. */
export const randomCrossId = (random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): bigint => random(6).reduce((a, x) => a * 256n + BigInt(x), 0n);

export type Grid = { minPrice: bigint; tick: bigint; ticks: number };

/**
 * A grid of `ticks` prices that covers `reference` plus and minus `halfBandBps`, with `reference` ON the grid (the program
 * requires a reference price to be a grid price). The tick is rounded up, so the band is at least as wide as asked; the lowest
 * price is never below one atom.
 */
export function gridAround(reference: bigint, halfBandBps: number, ticks: number): Grid {
  if (reference <= 0n) throw new PlanError('the reference price must be positive');
  if (!Number.isInteger(ticks) || ticks < 3 || ticks > 256 || ticks % 2 === 0) throw new PlanError('ticks must be an odd number from 3 to 255, so the reference sits in the middle');
  if (!Number.isInteger(halfBandBps) || halfBandBps < 1 || halfBandBps >= 10_000) throw new PlanError('the half band must be from 1 to 9999 basis points');
  const half = BigInt((ticks - 1) / 2);
  const width = (reference * BigInt(halfBandBps) + 9_999n) / 10_000n; // ceil: the distance from the reference to either edge
  let tick = (width + half - 1n) / half;
  if (tick < 1n) tick = 1n;
  if (reference <= tick * half) {
    // The band would reach zero or below: shrink the tick so the lowest price is still positive.
    tick = (reference - 1n) / half;
    if (tick < 1n) throw new PlanError(`a reference price of ${reference} atoms is too small to centre ${ticks} prices on`);
  }
  return { minPrice: reference - tick * half, tick, ticks };
}

export type RunMode = 'shadow' | 'send';

export type RunOptions = { mode: RunMode; rpc: RpcClient; sign?: Signer; onStatus?: (s: string) => void };

/** Runs the transactions of a plan. Shadow mode asks the cluster to simulate each one and sends nothing; send mode signs and sends them. */
export async function run(txs: readonly UnsignedTransaction[], o: RunOptions): Promise<{ mode: RunMode; simulations?: { ok: boolean; err: unknown; unitsConsumed: number | null; inconclusive: boolean; note: string | null }[]; signatures?: string[] }> {
  if (o.mode === 'shadow') {
    const r = await dryRun(txs, o.rpc);
    return { mode: 'shadow', simulations: r.map((x) => ({ ok: x.simulation.err === null, err: x.simulation.err, unitsConsumed: x.simulation.unitsConsumed, inconclusive: x.inconclusive, note: x.note })) };
  }
  if (!o.sign) throw new PlanError('send mode needs a signer');
  return { mode: 'send', signatures: await signSendConfirm(txs, { rpc: o.rpc, sign: o.sign, ...(o.onStatus ? { onStatus: o.onStatus } : {}) }) };
}
