# ADR-0920: Pool engines: DAMM v2 and DLMM priced with the venues' own arithmetic (D9, W9)

Status: accepted (2026-10-16). Extends ADR-0486.

## Decision

`packages/adapters/src/health.ts` keeps its constant-product helpers and gains decoders and quote engines for the two pools a cross opens.

- DAMM v2: the `Pool` account is decoded with the cp-amm SDK's own program coder and priced with its pure `swapQuoteExactInput`, so the fee scheduler, dynamic fee and compounding pools are the SDK's, not ours. The SDK refuses an input too small to return an atom and an input that leaves the price range; the engine reports the first as "takes it, returns nothing" and the second as "cannot take it".
- DLMM: `LbPair` and `BinArray` are decoded by offset (layout of `idls/lb_clmm.json`, checked on the fixtures: creator, mints, active bin). The swap is a port of `dlmm-sdk` `swapQuote`: per-bin fee, variable fee recomputed in every bin entered, volatility references decayed to the chain clock, limit-order liquidity, both fee-collection modes. A bin array that is not passed in holds no liquidity as far as a quote goes; the API reads nine around the active bin and says which.
- Every engine answers `swap`, `depth` (largest trade within a slippage limit, found by doubling then bisection above rounding dust), a mid price and reserves. `withTransferFees` applies a token-2022 transfer fee to both legs. `depthPersistence` turns observed depth into the share of time a size could be absorbed.
- No I/O. The API reads accounts and the Clock sysvar and passes bytes in.

## Why not the Meteora DLMM SDK

Its ESM build does not load under Node (noted in `dlmm.ts`), and importing it for a quote would drag its Connection-bound classes in. The port is small, and it is held to the real program (see evidence).

## Evidence and limits

Evidence: `docs/evidence/W5-1C.md`. Real devnet swaps on the three proof pools were quoted, simulated on the cluster and sent; the quote equalled the tokens received in all but one, and that one (300 atoms in 42 million) was a quote taken inside the 10 s filter period of the pair's variable fee and executed after it. A probe showed the quote tracks the simulation second by second.

NOT VERIFIED: limit-order liquidity (no pair on chain holds an order; tested on constructed bins), `collectFeeMode` 1 (constructed), slot-activated pools (constructed), DAMM fee scheduler and rate limiter modes other than the flat fee of the proof pool (they are the SDK's, not exercised here).
