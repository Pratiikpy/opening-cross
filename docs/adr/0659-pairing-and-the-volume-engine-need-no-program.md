# ADR-0659: Multi-asset pairing (R4) and the Meteora volume engine (X14, R1) need no program of ours

Status: accepted (2026-10-14) · Closes the "NOT BUILT, needs program design" outcome of ADR-0486 for R4, X14 and R1

## R4: multi-asset pairing on one liquidity layer

[R4]: "stock-, ICM-, RWA- and stablecoin-quoted pools with cross-pair routing." What a program could add here is already there: every adapter takes the quote mint from the cross (`seed_damm_v2`, `open_dlmm_pair`, `seed_raydium_cpmm`, the new `seed_futarchy_dao`), and ADR-0485 proved a stock-like quote mint (Token-2022 with a pausable extension and a permanent delegate) on DLMM with a Meteora Token Badge. Which pairs exist is a fact of the market, not a rule a program can enforce. **Cross-pair routing** (a trade from asset A to asset B through a common quote) is the router's job (`packages/router`): it quotes pools and builds the swap transactions. There is no custody, no authority and no invariant on the pair itself.

## X14 and R1: the Meteora-native volume engine

[X14, R1]: "reopens on our DLMM + Alpha Vault pools; post-cross volume and LP routed to Meteora by default; Meteora fees and TVL we generate reported as a headline metric." Its three claims map to things that exist or are not programs:

- Reopens: the series scheduler and the calendar (`Y1`, `W2D-Y1.md`).
- DLMM and Alpha Vault pools opened at P*: `open_dlmm_pair`, the batch window, the Alpha Vault entry and the greenshoe (`W2D-X13.md`, `W2D-D4`).
- "Routed to Meteora by default": a default in the issuer console and the router, not an on-chain rule (and a rule that forced a venue would conflict with the graduation vote, ADR-0656).
- The headline metric: the fees and TVL of pools opened through our adapters. That is a read of public accounts (the pool and position accounts each adapter creates, whose addresses are derived from the cross), which an indexer table and an API route compute. It needs no authority on chain and a program would add nothing but a number the chain already holds.

## Consequences

Both rows stay application-layer rows; `docs/evidence/W3D-R4-X14.md` lists the work for the indexer, router and console.
