// The fee rules of cross_core (ADR-0010), written as integer functions that mirror the program line for line.
// Nothing here is a model or an estimate: given the same inputs these functions return exactly what the program
// transferred, which is how the ledger proves every fee against the chain.
//
// Rules, with the program line each one comes from:
//   protocol fee bps       = min(schedule[kind], integrator_bps / 4)            create_cross
//   total fee bps          = protocol bps + integrator bps                       Cross::total_fee_bps
//   escrow mode, per claim = floor(seller_gross * total_bps / 10_000)           claim (sell side)
//   mint mode, at finalize = floor(buyer_paid * total_bps / 10_000)             finalize
//   protocol share         = floor(fees * protocol_bps / total_bps)             finalize
//   integrator share       = fees - protocol share                              finalize
// A fee is never charged on a bid, a cancel or a refund.

export const KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;
export type CrossKind = (typeof KINDS)[number];
export type SupplyMode = 'escrow' | 'mint' | 'deferred-mint';

/** Basis points per whole. */
export const BPS = 10_000n;
/** Hard cap on any protocol schedule entry (programs/cross_core/src/state.rs MAX_PROTOCOL_FEE_BPS). */
export const MAX_PROTOCOL_FEE_BPS = 100;
/** Integrator fee ceiling (MAX_INTEGRATOR_FEE_BPS). */
export const MAX_INTEGRATOR_FEE_BPS = 300;
const U64_MAX = (1n << 64n) - 1n;

/** Protocol fee per cross kind, in bps of filled notional, indexed like `KINDS`. */
export type FeeSchedule = readonly [launch: number, reopen: number, tender: number, recurring: number];

/** The schedule proposed in ADR-0010: 30 bps launches, 5 reopens, 15 tenders, 30 recurring. Not modelled against demand. */
export const PROPOSED_SCHEDULE: FeeSchedule = [30, 5, 15, 30];

export class FeeError extends RangeError {
  override readonly name = 'FeeError';
}

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new FeeError(`${what} must fit an unsigned 64-bit integer, got ${v}`);
  return v;
}

function bpsOf(v: number, what: string, max: number): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new FeeError(`${what} must be an integer in [0, ${max}], got ${v}`);
  return v;
}

export function validateSchedule(schedule: readonly number[]): asserts schedule is FeeSchedule {
  if (schedule.length !== KINDS.length) throw new FeeError(`a fee schedule has ${KINDS.length} entries, got ${schedule.length}`);
  schedule.forEach((b, i) => bpsOf(b, `schedule[${KINDS[i]}]`, MAX_PROTOCOL_FEE_BPS));
}

/** `floor(amount * bps / 10_000)`, the program's `mul_bps`. Throws where the program would overflow u64. */
export function mulBps(amount: bigint, bps: number): bigint {
  u64(amount, 'amount');
  const v = (amount * BigInt(bpsOf(bps, 'bps', 65_535))) / BPS;
  return u64(v, 'fee');
}

/** The protocol fee a cross snapshots at creation: the schedule entry, capped at a quarter of the integrator fee (integer division). */
export function protocolFeeBps(schedule: FeeSchedule, kind: CrossKind, integratorBps: number): number {
  validateSchedule(schedule);
  bpsOf(integratorBps, 'integratorBps', MAX_INTEGRATOR_FEE_BPS);
  return Math.min(schedule[KINDS.indexOf(kind)] as number, Math.floor(integratorBps / 4));
}

export const totalFeeBps = (protocolBps: number, integratorBps: number): number => Math.min(protocolBps + integratorBps, 65_535);

export type FeeSplit = { readonly total: bigint; readonly protocol: bigint; readonly integrator: bigint };

/** The split `finalize` pays: the protocol gets its share of the total, the integrator the remainder. */
export function splitFees(total: bigint, protocolBps: number, integratorBps: number): FeeSplit {
  u64(total, 'total fees');
  const t = BigInt(totalFeeBps(protocolBps, integratorBps));
  const protocol = t === 0n ? 0n : u64((total * BigInt(protocolBps)) / t, 'protocol fee');
  return { total, protocol, integrator: total - protocol };
}

export type FinalizeInputs = {
  readonly supplyMode: SupplyMode;
  readonly protocolBps: number;
  readonly integratorBps: number;
  /** `Cross.buyerPaid`: what buyers paid in total at claim. Used in mint modes. */
  readonly buyerPaid: bigint;
  /** `Cross.feesAccrued`: the sum of the per-claim seller fees. Used in escrow mode. */
  readonly feesAccrued: bigint;
};

/** The fees `finalize` transfers, from the cross account's own counters. */
export function expectedFinalizeFees(i: FinalizeInputs): FeeSplit {
  const total = i.supplyMode === 'escrow' ? i.feesAccrued : mulBps(i.buyerPaid, totalFeeBps(i.protocolBps, i.integratorBps));
  return splitFees(total, i.protocolBps, i.integratorBps);
}

/** What one seller pays in escrow mode, from the gross proceeds of their fill: the program's per-claim fee. */
export function sellerFee(gross: bigint, protocolBps: number, integratorBps: number): bigint {
  return mulBps(gross, totalFeeBps(protocolBps, integratorBps));
}

/** Fee as a share of notional in basis points, to one decimal place as an integer count of tenths of a basis point. */
export function effectiveTenthsBps(fee: bigint, notional: bigint): bigint | null {
  return notional === 0n ? null : (fee * 100_000n) / notional;
}
