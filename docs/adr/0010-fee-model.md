# ADR-0010: Fee model enforced on chain

Date: 2026-10-05 · Status: accepted · Implements Decisions log #2 and PRD [W4, W6]

## Decision
- Fees are charged only on filled notional and paid by the sell side; buyers pay exactly P\*. Bids, cancels and refunds are never charged.
- Each cross snapshots its fees at creation; protocol schedule changes never affect live crosses.
- Integrator fee: 0–300 bps, set by the venue that creates the cross.
- Protocol fee: `min(schedule[kind], integrator_bps / 4)`. That is the plan's "protocol take ≤ 20% of total fees" written as an equality (`p ≤ 0.2 · (p + i) ⇔ p ≤ i / 4`), mirroring Doppler's cap (`Airlock.sol` `_handleFees`, research RT7). A cross with no integrator fee therefore pays no fees at all: the zero-fee public-good tier needs no special case.
- The Opening Bell app earns as an integrator like any other venue, which keeps the protocol venue-neutral.

## Evidence
`tests/core/test/fees.test.ts` (share formula for integrator 0/3/20/120/300 bps; public-good tier pays nothing; schedule change leaves a live cross untouched; cancel and no-print refunds are free) and `tests/core/test/flows.test.ts` (exact protocol and integrator payouts at finalize).

## Not yet built
The optional 10% referrer share from W6. It needs a referrer field per order and is deferred until a referral programme exists; nothing in the current fee path depends on it. Final bps values are modelled before mainnet (Decisions log #2).
