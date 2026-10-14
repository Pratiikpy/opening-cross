# ADR-0658: Zap in and out is a transaction the client builds, not a program of ours (D8)

Status: accepted (2026-10-14) · Closes the "NOT BUILT, needs design" outcome of ADR-0486 for D8

## Context

PRODUCT_FEATURES [D8]: "Zap in/out at every pool stage." ADR-0486 and `FEATURE_STATUS.md` said Zap "routes through Jupiter, which answers on mainnet only, so it cannot be proved on devnet". `idls/zap.json` holds Meteora's Zap program (v0.2.0, `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`); its instructions are `initialize_ledger_account`, `set_ledger_balance`, `update_ledger_balance_after_swap`, `zap_in_damm_v2`, `zap_in_dlmm_for_initialized_position`, `zap_in_dlmm_for_uninitialized_position`, `zap_out` and `close_ledger_account`.

## Decision

Nothing is added to our programs. A zap is a **sequence of instructions in one user-signed transaction**: open the ledger, swap one side with an external router (Jupiter), update the ledger, add liquidity to the pool or position, close the ledger. It spends the user's own tokens under the user's own signature. There is no authority for a program of ours to hold, no invariant for it to enforce and no state for it to keep, so a wrapper program would add attack surface and an upgrade cost and take away nothing a client does not already do.

What the product needs is a **builder** in `packages/adapters`: `buildZapIn(pool stage, user, amount, slippage)` and `buildZapOut(...)` for the three stages a market passes through (DBC curve, DAMM v2 pool, DLMM position), composed from `idls/zap.json` and a swap quote from the router. That is an application-layer task and is listed in `docs/evidence/W3D-D8.md`.

## What can and cannot be proved

- The Zap program's own instructions can be exercised on LiteSVM only with the Zap binary and, for the swap leg, a router; Jupiter answers on mainnet. A devnet or LiteSVM proof of the whole zap is therefore not available, and nothing in this ADR claims one. The builder's output can be proved structurally (instruction order, accounts, the ledger lifecycle) and by a mainnet simulation (`simulateTransaction`, no funds moved), which needs a mainnet RPC endpoint and no keys.
- The fee and slippage the user sees are the router's quote and the pool's: the builder shows both and refuses a quote older than a few seconds.

## Consequences

- Row D8 stays an application-layer row. The first step is the builder and its structural tests; the mainnet simulation is the evidence that the transaction is accepted, and the only external requirement is an RPC endpoint.
