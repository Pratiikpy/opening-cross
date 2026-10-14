# W3D-D8: Zap in and out (decision: no program of ours)

Outcome: **NOT DOING in the programs; application-layer builder.** ADR-0658. Row D8.

A zap is one user-signed transaction: open Meteora's ledger account, swap one side through an external router, update the ledger, add liquidity (`zap_in_damm_v2`, `zap_in_dlmm_for_initialized_position`, `zap_in_dlmm_for_uninitialized_position`) or take it out (`zap_out`), close the ledger. It spends the user's own tokens under the user's own signature; a program of ours would hold no authority and enforce no invariant. The interface is in `idls/zap.json` (v0.2.0, `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`).

Checked on 2026-10-14: the program account answers on devnet and on mainnet (`solana program show`); Jupiter, the swap leg's router, is a mainnet service.

## FEATURE_STATUS row wanted

`| D8 Zap | NOT BUILT | none; the decision is that a zap is a client-built transaction, not a program (ADR-0658) | An SDK builder `buildZapIn` and `buildZapOut` for the three pool stages (DBC, DAMM v2, DLMM) composed from `idls/zap.json` and a router quote; proved structurally and by a mainnet `simulateTransaction`, since the swap leg cannot run on devnet or LiteSVM |`

## What the app layers must add

`packages/adapters`: `buildZapIn` and `buildZapOut` for DAMM v2 and DLMM (the DBC stage has no Zap instruction: a curve is bought into with a normal swap), taking a router quote and a slippage bound; refuse a quote older than a few seconds; return the ordered instructions and the ledger lifecycle. Tests: instruction order and accounts against the IDL; a mainnet simulation behind an `RPC_URL` guard. Web: a "Zap" action on a pool page that shows the router's fee and the pool's. Not covered here: any of it; this file records the decision.
