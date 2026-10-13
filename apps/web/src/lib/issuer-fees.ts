// The fee a cross snapshots, as cross_core computes it (ADR-0010, OCIP-1 section 7.6), for the console to show before anything is signed.
// A parity test checks these against packages/fees, which mirrors the program line for line.
export type Kind = 'launch' | 'reopen' | 'tender' | 'recurring';

/** The schedule proposed in ADR-0010. The live one is set on chain by the protocol admin and read through the API; this is shown only when that read fails, and named as proposed. */
export const PROPOSED_FEES: Record<Kind, number> = { launch: 30, reopen: 5, tender: 15, recurring: 30 };

export const MAX_INTEGRATOR_FEE_BPS = 300;

/** The protocol fee in basis points: the schedule entry for the kind, capped at a quarter of the integrator fee (integer division). */
export const protocolFeeBps = (schedule: Record<Kind, number>, kind: Kind, integratorBps: number): number => Math.min(schedule[kind], Math.floor(integratorBps / 4));

/** Total basis points charged on filled notional to the sell side; a cross with no integrator fee pays no fee at all. */
export const totalFeeBps = (protocolBps: number, integratorBps: number): number => Math.min(protocolBps + integratorBps, 65_535);
