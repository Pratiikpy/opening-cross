# ADR-0351: Float and value guardrails are enforced through parameters `cross_core` already has

Status: accepted (2026-10-13)

## Context

PRODUCT_FEATURES B13 asks for a minimum public float and a maximum fully diluted value, enforced on chain. FEATURE_STATUS lists it as not built. The programs workstream is adding dedicated `min_float_bps` and `max_fdv_x100` guards to `cross_core` (uncommitted at the time of writing). The deployed devnet program does not have them.

## Observations

- Once a minting cross exists, its mint authority is the cross, so the token's total supply after settlement is exactly the supply before it plus what the cross mints, which is the quantity that traded. In an escrow cross the supply is fixed. Float, tokens sold over total supply after the cross, is therefore a function of one number, `matched`.
- `min_matched` already makes the program refuse to print below a number of tokens (OCIP-1 section 7.7).
- The cross cannot clear above the highest price on its grid.

## Decision

The wizard turns the issuer's own limits into those two parameters and shows the translation:

- Minimum float f (basis points): the minimum volume becomes the smallest `m` with `m / total >= f`. Mint mode: `m >= ceil(f * S / (10000 - f))` for existing supply `S`; escrow mode: `m >= ceil(f * S / 10000)`. A float of 100% is impossible in mint mode and the form says so. The effective minimum is the larger of this and any minimum the issuer typed.
- Maximum fully diluted value V: the top of the grid must satisfy `top * (S + maxSold) / priceScale <= V`, where `maxSold` is the supply the issuer lists (mint mode) or zero (escrow). The form refuses a grid above it, says how many levels fit, and offers to shorten the grid.
- The limits are the issuer's own and nothing in the product sets a number: no default float or value ceiling is proposed. FDV over raise equals the reciprocal of the float when the cross is the only sale, and the page says so.

The translation is tested on arithmetic (minimality, bounds) and end to end: a devnet cross created from the wizard with a 5% float rule carries `min_matched = 473684211` on chain for 9,000 tokens already minted (`docs/evidence/W2B-B13.md`).

## Consequences

- B13 is enforced today on the deployed programs, at creation time, from the supply read then. A supply that changes between reading and creating (the issuer minting more) would move the float; the readiness list is re-read on demand and before signing the issuer sees the figures.
- When the programs workstream's guards ship, the wizard can send them directly and keep this translation as the fallback for crosses on the older layout. Insider-excluded allocations (VM7) are not modelled here.
