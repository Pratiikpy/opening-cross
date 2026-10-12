# ADR-0023: DLMM conviction ladder above the clearing price

Status: accepted (2026-10-13)

## Context

`open_dlmm_pair` opens a Meteora DLMM pair whose active bin is the one nearest P* (evidence `A3`). The pair is empty: liquidity is added afterwards with DLMM's own instructions. FEATURE_STATUS row D5 asked for a "conviction pool": the issuer commits the tokens the auction did not sell, as depth that only sells above the clearing price.

## Decision

`buildDlmmConvictionLadder` (packages/adapters) builds, with no change to `cross_settle`, the DLMM instructions that open a position over the bins just above the active bin and fill it with base tokens only: `initialize_bin_array` for the arrays the ladder and the active bin sit in, `initialize_position`, and `add_liquidity_by_strategy2` with Meteora's own imbalanced strategies. The shape is `flat` (SpotImBalanced), `taper` (CurveImBalanced, deepest near P*) or `wall` (BidAskImBalanced, deepest at the top).

Rejected: `add_liquidity2` with hand-written weights, which Meteora's program refuses for a single-sided deposit with `InvalidInput`; and the OneSide strategies, which it refuses with `InvalidStrategyParameters` for this range. Both were tried against the real binary before choosing the imbalanced strategies.

## Consequences

- Nothing in the ladder sells below the first bin above P*; a larger buyer walks up it at DLMM's own bin prices.
- DLMM keeps a few atoms of rounding dust with the depositor. The ladder is a normal Meteora position owned by the creator; withdrawing it uses Meteora's own instructions, and nothing here locks it.
- Proven in LiteSVM on the real lb_clmm binary; not on devnet (no SOL).
