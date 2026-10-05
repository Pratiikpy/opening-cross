# ADR-0008: DLMM pair adapter

Date: 2026-10-05 · Status: accepted · Builds on ADR-0006, ADR-0007

## Decision
`cross_settle::open_dlmm_pair` lets the cross creator open a Meteora DLMM customizable permissionless pair for the cross's market after it clears. Token X is the base asset and token Y the quote. DLMM prices live on discrete bins, `(1 + bin_step/10⁴)^id`, so P\* is rarely exactly representable; the adapter accepts only an active bin whose price is within **half a bin step** of P\*, computed on chain with exact Q64.64 integer exponentiation (`bin_price_q64`, mirrored in `@opening-cross/meteora-adapters`). Liquidity is added afterwards with DLMM's own instructions; adding liquidity cannot move the active bin.

## Evidence
LiteSVM against the mainnet lb_clmm binary (`tests/core/test/dlmm.test.ts`): P\* = 1.2 with a 10 bps bin step opens at bin 182 (price 1.19951, −4 bps); liquidity in bins 181–183; a real 10-token swap returned 11.983 quote against 12.000 at P\*. A shifted active bin and non-creators are refused.

## Notes
The `@meteora-ag/dlmm` package fails to load under Node ESM (directory import), so its five PDA derivations are reproduced from its source (`helpers/derive.ts`) instead of importing it.
