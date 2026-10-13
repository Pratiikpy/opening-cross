# ADR-0486: Liquidity health helper (D9) and the Meteora rows this batch did not build

Status: accepted (2026-10-13)

## D9

`packages/adapters/src/health.ts` is a pure function module: exact integer constant-product quote, slippage in basis points, depth at a slippage limit and time-weighted persistence over snapshots. It covers full-range DAMM v2 pools, whose two vault balances fully determine the curve; there is no on-chain part because nothing about a read-only metric needs program authority. DLMM depth depends on the bins and is not covered.

## D6 protocol market making and community LP vault: not building, by principle

A vault in which an operator key trades and manages other people's liquidity is custody. ENGINEERING_PRINCIPLES section 3 and 15 forbid any authority that can drain user funds, and no Meteora instruction makes such a vault safe by itself (the operator can always remove liquidity it manages). What the product can offer instead is owner-held liquidity with program-enforced limits: the locked design (ADR-0482), the conviction ladder (ADR-0023) and the greenshoe (ADR-0487). The orchestrator decides whether D6 stays on the list.

## Not built in this batch (no code, no stub)

- D10/Z0 graduation by holder vote: DBC migration is permissionless once the curve completes, so a vote cannot gate it; a vote can only gate a creator-initiated graduation such as `seed_damm_v2`, which needs a vote-escrow account family and a retention/organic-volume signal the program cannot compute. Design recorded, not built.
- B4 Presale Vault integration (a fixed-price presale at `q_price = floor(P* · 2^64 / price_scale)`), D8 Zap, X14/R1 (a reporting metric with no on-chain part), R4 pairing (the adapters already accept any quote mint; ADR-0485 proves a stock-like quote mint on DLMM; cross-pair routing is the router's), W2 timelock enforcement (needs the Squads handover H13 to mean anything), X3 MetaDAO adapter (`tests/fixtures/futarchy.so` and `genesis.so` were not examined), R3 upstream contributions (human-gated).
