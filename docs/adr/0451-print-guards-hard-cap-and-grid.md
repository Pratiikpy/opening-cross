# ADR-0451: Print guards, the published hard cap, and the standard grid

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES B5, B13, B1 (reserve and ticks) and the print-guard half of W8. Builds on ADR-0003 and ADR-0450.

## Context

ADR-0003 ends with three guards: minimum matched volume, maximum imbalance and an oracle band. The specification asks for more: a minimum raise in money, a minimum public float, a maximum FDV-to-raise ratio, a published hard cap, "the issuer chooses the accepted amount within published rules", a reserve and tick policy, a bound on how far the price may move from the issuer's estimate, and a halt or corporate-action flag. All of them must keep the properties of the clearing rule: deterministic, order independent, recomputable by a stranger.

## Decision

**Pure guards**, in `clearing_core::guards`, in a fixed order, each a function of the clearing summary and published numbers:

1. minimum matched volume, on the **counted** volume (a declared insider's allocation is left out, ADR-0454);
2. maximum imbalance;
3. minimum raise: `floor(counted · P* / price_scale) ≥ min_raise_quote`;
4. float: `counted · 10,000 ≥ min_float_bps · total_supply`;
5. valuation: `total_supply · 100 ≤ max_fdv_x100 · counted` (float and valuation are one ratio read two ways; both are enforced because the specification names both, and either can be off);
6. price move: `|P* − anchor| · 10,000 ≤ move_bps · anchor`.

`total_supply` is declared by the issuer, or read from the base mint at the clear when it is not declared and the mint exists (not possible for a deferred-mint cross). The anchor is the issuer's explicit anchor, the reopen reference, or the grid estimate, in that order, fixed when the rules are set.

**What "a ±20% move forces buyers to re-sign" means on chain.** A confirmation round (every bidder re-signs when the indicative price moved) would need per-order removal from an aggregated book, one transaction per order. The rule implemented is the other half of the same promise: when the clearing price lands further from the anchor than the cross allows, the cross does not print and every order is refunded in full (`PriceMoved`), and buyers place new orders in a follow-up cross. A buyer's signed order is never executed at a price the cross's published bound excludes, and nothing executes half-confirmed. The wallet-side reminder when the indicative price moves is an interface rule (the SDK's `coarseIndicative` helper), not a program rule.

**The hard cap and "the issuer chooses the accepted amount" (B5).** `max_matched` is the most base the sell side delivers, however many levels the schedule offers: `clearing_core::clear_with(.., Some(cap))` applies `S(p) = min(S(p), cap)` and `S⁻(p) = min(S⁻(p), cap)`, and the price rises until demand fits. The cap is set before the call, in the rules, and cannot change. The specification's wording, a choice made **after** the issuer has seen the demand, is **not** implemented, on purpose: an issuer that picks the amount after seeing the book can withhold supply to raise the price, which the pre-committed schedule exists to prevent (design rule 2, no discretionary pricing or allocation, and the demand-reduction argument behind ADR-0003). The published cap and the published minimum raise are the "rules within which the issuer chooses", chosen before bids exist. This is a deliberate narrowing of the row's wording; the orchestrator decides whether to keep it (`FEATURE_STATUS` says so).

**Standard grid (B1).** With `FLAG_STANDARD_GRID` and a published `grid_estimate`, `set_rules` refuses a grid whose first price is below half the estimate, whose tick exceeds one percent of it, or that does not contain it. Crosses that do not set the flag keep the issuer's free grid.

**State-of-the-world guards**, evaluated after the pure ones because they cannot be recomputed from the book: base mint paused (`IssuerPaused`), a halt or corporate action in force (`Halted`, `CorporateAction`, ADR-0455), a scaled-UI multiplier that changed (`CorporateAction`, ADR-0459), the oracle (ADR-0459). The independent verifier reports these as "not reproducible from the book" and checks that the cross did not print.

**One extension, then "no cross".** A cross with an `extension` rule that fails any guard does not give up at once: the first failure sets `ext_pending`, a draw picks a length in the published range (ADR-0452) and the call reopens once. The second failure is final. If nobody finishes the draw the cross clears as it stands after three days, so funds are never stranded.

New `NoPrintReason` values are appended (indexes 6 to 13): `BelowMinimumRaise`, `FloatTooLow`, `FdvTooHigh`, `PriceMoved`, `Halted`, `CorporateAction`, `IssuerPaused`, `OracleDisagreement`.

## Evidence

`tests/core/test/rules-guards.test.ts` (18 tests): every guard at, one atom inside and one atom outside its bound; six caps compared with the independent TypeScript reference on price, volume and **every fill**; the standard grid accepted and refused; refunds after a refused print; the lender feed. `crates/clearing-core` unit and property tests; the 525 v1 vectors and the new v2 vectors (`packages/verifier/conformance/v2.json`, regenerated byte-identically by `cargo run -p clearing-core --example conformance_vectors_v2`) are reproduced by the verifier's independent implementation.

## Consequences

The verifier (`verifyCross`) understands crosses with rules (fairness proof schema v2). Clients reading `noPrintReason` need the eight new names; `services/api/src/server.ts` and `packages/client/src/chain.ts` list them.
