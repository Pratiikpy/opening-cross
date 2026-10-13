# ADR-0483: Batch-opened pools (F4, W10) and Met Lock vesting

Status: accepted (2026-10-13) · Builds on ADR-0007, ADR-0008, ADR-0022

## Batch-opened pools

PRODUCT_FEATURES [F4] wants the first minutes after seeding to clear as frequent batch auctions, and [W10] wants the pool paused while the call runs and opened at P*. Meteora has no instruction that lets a third party pause someone else's pool, so the only pause that exists is the one the pool is born with: DAMM v2 refuses every swap before its activation point (`PoolDisabled`, read from the real binary), and a DLMM pair created with a timestamp start behaves the same way.

`seed_damm_v2_batched` and `open_dlmm_pair_batched` are `seed_damm_v2` and `open_dlmm_pair` plus a check, in `batch.rs`, that the pool or pair has a timestamp start at least `window_secs` away (30 seconds to 7 days). The DAMM pool must also compound its fees and open with a time-scheduler fee that decays (`BaseFeeMode` 0 or 1 with at least one period and a positive reduction), which is the "decaying scheduler fee as backstop" and sends early fees to the pool's own liquidity. During the window the market clears as ordinary `Recurring` crosses; creating them is the keeper's job (Y1) and is not enforced by this program. After the window the pool opens at the price the last cross printed only if the issuer seeded it from that cross: the instruction still checks `sqrt_price == P*`.

Not enforceable on chain: that any cross runs during the window, and the rebalancing of pools the issuer did not open with this adapter (those rebalance by arbitrage).

## Met Lock

Met Lock is a standalone vesting program; nothing about it needs `cross_settle` to sign. `packages/adapters/src/metlock.ts` builds `create_vesting_escrow_v2` and `claim_v2` and a schedule function whose three numbers always sum to the total exactly (the remainder joins the cliff unlock). Proven on the real binary: the escrow holds the whole schedule, a claim releases exactly the amount the function computes at six instants, and a claim signed by anyone but the recipient moves nothing. DBC's own `locked_vesting` config and `create_locker` already vest team tokens through the same program; this adapter is for tokens an issuer holds outside the curve.

## Consequences

`cross_settle` grows by two instructions and one pure module. A DLMM batch window with `has_alpha_vault` is the entry point for ADR-0484.
