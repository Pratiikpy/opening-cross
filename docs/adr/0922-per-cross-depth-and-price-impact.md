# ADR-0922: Per-cross depth and price impact (X8)

Status: accepted (2026-10-16).

## Decision

A cross has no continuous book and no marginal price, so its "depth" and "slippage" are defined for what it is. `crossDepth` (`packages/router/src/depth.ts`) reads the live book and returns: the resting quantity at each price with the running totals a depth chart shows; where the cross would clear now; and, for orders of set sizes on each side, the clearing price with a market order of that size added against the price without it (the order is added last, as `quoteCross` adds it). Impact is signed from the order's side. The clearing rule is the verifier's reference implementation.

A sealed book is reported hidden, as are books of crosses that are no longer accepting orders (with the on-chain outcome). Nothing is modelled for them.

`GET /v1/depth/cross/:address` returns this beside the pools of the pair priced for the same sizes. The two are different quantities (a change in a clearing price; a shortfall against a mid price) and are shown side by side, not merged.

## Comparators

The row asks for a comparison with pump.fun and MetaDAO. Neither is built: their on-chain curve parameters were not verified here, and a number from memory would be a fabricated benchmark. NOT VERIFIED, not built. Per-venue volume needs swap events the indexer does not store; also not built.

## Evidence

A real cross on devnet: the route's baseline equalled the reference clearing; the price it predicted for a market buy of 2,500 tokens (1.30 to 1.60, +2,308 bps) equalled the baseline read after that order was placed.
