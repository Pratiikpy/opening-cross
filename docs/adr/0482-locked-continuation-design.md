# ADR-0482: The locked, compounding continuation design is enforced by the program

Status: accepted (2026-10-13) · Rows D3, D1 · Builds on ADR-0006, ADR-0022

## Context

PRODUCT_FEATURES [D3] asks for a launch whose liquidity cannot be pulled and whose migrated market compounds. `open_dbc_pool` checks only the start price (P*), the token type and the mint authority option; the rest of the DBC config is the issuer's choice. A buyer in the cross cannot tell from the cross itself whether the opening liquidity will be withdrawable the moment the pool migrates.

## Decision

A new instruction `open_dbc_pool_locked` runs every check `open_dbc_pool` runs and then refuses, in `design::check_locked_design`:

1. a migration that is not DAMM v2;
2. a migrated pool that is not in the `Compounding` collect-fee mode with a compounding fee between 1 and 10,000 bps;
3. any unlocked liquidity (`partner_liquidity_percentage` and `creator_liquidity_percentage` must be zero), so nothing is withdrawable at migration;
4. any vesting on the partner side, because the partner position belongs to the settler PDA, which has no instruction that vests or removes liquidity: partner liquidity may only be locked for good (its fees are claimed by `claim_pol_fees`);
5. less than 20% of the migration liquidity locked permanently across both sides (PRODUCT_FEATURES [D1]: about 20%);
6. creator vesting with zero periods or a zero step.

DBC itself requires the liquidity percentages to sum to 100, so what is not locked permanently must vest to the issuer. A compounding migration needs DBC's `Customizable` migration fee option; DBC refuses a compounding config under any fixed option, so (2) implies it.

`claim_pol_fees` lets anyone claim the fees of the settler-owned position (DAMM v2 `claim_position_fee`, signed by the settler) to accounts owned by `Cross.proceeds_to` (ADR-0481). The creator's position belongs to the issuer's wallet, which claims fees and refreshes vesting with Meteora's own instructions.

The existing `open_dbc_pool` is unchanged and stays available for issuers who want a different design. The pool's config is on chain, so a buyer can see which instruction opened it and whether the guarantee applies.

## Not done, and why

- "One transaction": open and bind are two instructions in one transaction (`buildLaunchTransaction` in `@opening-cross/adapters`). That is atomic as a transaction. A single program instruction would put about 35 accounts and the curve parameters in one instruction; the measured transaction sizes are in `docs/evidence/W2D-D3.md`.
- Mint authority revoked in the same transaction as allocation, and proceeds routed to a treasury at settlement: those belong to `cross_core`'s `finalize` and the treasury program.
- Demand-calibrated curve segments: the issuer's `sqrtPriceMultiples` stay explicit.

## Consequences

- A cross opened with `open_dbc_pool_locked` carries a program-enforced promise instead of a UI one.
- Gated mints still need a DAMM v2 Token Badge to graduate (ADR-0004, H9) where the mint has Default Account State; the LiteSVM migration with a transfer-hook mint was accepted by DAMM v2.
- Compounding liquidity takes a protocol fee out of the migration amounts, so the curve needs a small supply margin; DBC's own check reports `InvalidTokenSupply` otherwise. The tests use a 5,000,000-token leftover.
