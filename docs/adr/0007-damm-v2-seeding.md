# ADR-0007: DAMM v2 seeding adapter

Date: 2026-10-05 · Status: accepted · Builds on ADR-0006

## Decision
`cross_settle::seed_damm_v2` lets the cross creator open a Meteora DAMM v2 customizable pool for the cross's market once it has cleared. Token A is the base asset and token B the quote, so DAMM's price (B per A) is the cross's price. The adapter rejects any `sqrt_price` that is not `floor(sqrt(P* / price_scale) · 2⁶⁴)` to within one unit, so the pool opens exactly where the cross printed (invariant 10). The issuer supplies liquidity from its own accounts and receives the position NFT (minted at a per-cross PDA); fees, range and collect mode are the issuer's choice. The default client path is full range (constant product) with fees collected in the quote token.

## Evidence
LiteSVM against the mainnet cp-amm binary (`tests/core/test/damm.test.ts`): DAMM's own pool account decodes to `sqrt_price = sqrtPriceQ64(P*)`; a real 10-token swap through DAMM returned 11.94 quote against 12.00 at P* (0.3% fee plus impact); tampered prices and non-creators are refused.

## Consequences
Anyone can still create a DAMM v2 pool at another price directly; the adapter is the path that carries the cross's guarantee and emits a receipt (`DammV2Seeded`) the indexer and verifier use.
