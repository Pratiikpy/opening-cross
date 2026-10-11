# ADR-0018: Volatility-aware trading fees

Status: accepted (2026-10-11)

## Context

PRODUCT_FEATURES [D3] puts a dynamic fee on the DBC continuation, and the brief for the trust layer asked for two things: fees that rise when a launch turns volatile, and, if possible, fees that depend on the market session of the underlying (pre-market, overnight, weekend).

## What the programs offer (verified)

- **Volatility layer: yes.** DBC's `PoolFeeParameters` carries an optional `DynamicFeeParameters` (bin step, filter period, decay period, reduction factor, max volatility accumulator, variable fee control). The fee is `ceil((accumulator × bin step)² × variable fee control / 10¹¹)` on top of the base fee, capped so base plus dynamic stays under 99%.
- **Session-aware fee: no.** Neither the DBC nor the DAMM v2 IDL has a mode keyed to a calendar or session, and the Meteora docs list only the base modes (linear and exponential scheduler measured from activation; the rate limiter, deprecated for new configs) plus the volatility layer. A session-aware fee cannot be set on the pool. The only way to approximate one is to change fee parameters from outside the pool on a schedule, which needs an authority the pool may not give us after graduation; it is not built.

## Decision

`@opening-cross/adapters` gains `volatilityFeeParams` / `dynamicFeeNumerator` / `dynamicFeeBps` / `maxDynamicFeeBps`, and `ContinuationDesign.dynamicFee` to carry explicit parameters into the DBC config.

A design is stated in product terms: the base fee, how much the dynamic layer may add as a share of it, the price move at which that cap is reached, and the filter and decay periods. The SDK's own helper fixes the cap at 20% of the base fee; this lets an issuer choose, and refuses designs the chain cannot express (variable fee control over the 24-bit limit, total over 99%, filter not below decay), naming the largest share that would fit. With a 20% share it reproduces the SDK helper exactly (tested for four base fee and price move pairs).

## Measured behaviour on devnet (a finding that changes how to use it)

`docs/evidence/DP-volatility-fee.md` (real DBC program, real swaps, fee read from the pool's three fee counters). Over seven swaps the chain matched the model to 0.012 bps. The model is exact **if the accumulator is the one stored when the swap starts**:

- The fee a swap pays comes from the volatility earlier swaps left behind; the accumulator is updated after the swap charges. The first swap that moved a fresh pool 25% paid 103.84 bps, not the cap; the next paid the cap.
- Decay is applied lazily. After 38 s of quiet (decay period 30 s) the next swap still paid the old rate (200.00 bps); the one after paid 101.66 bps.

Consequences for design: the dynamic layer does not charge a single large buyer for their own move; it charges the flow that follows. Launch protection against a first-block sniper therefore belongs to the base fee mode (a scheduler that starts high and decays), with the dynamic layer protecting against sustained volatility. The default recommendation is both together.

## Not covered

- DAMM v2's own dynamic fee after migration (a separate parameter set).
- The Token-2022 hooked-mint swap path (proved separately in DP5); this proof used a plain SPL pool.

## Verification

`packages/adapters/test/fees.test.ts` (8 tests: SDK parity, cap, monotonicity, agreement with the SDK fee model at 7 readings, refusal cases, config override); `tests/devnet/src/volatility-fee-proof.ts` against devnet DBC.
