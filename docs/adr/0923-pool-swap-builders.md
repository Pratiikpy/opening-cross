# ADR-0923: Swap instructions for the pools a cross opens (W9, K5)

Status: accepted (2026-10-16).

## Decision

`packages/liquidity/src/pool-swap.ts` builds an exact-input swap instruction for a DAMM v2 pool (`swap2`, mode ExactIn) and a DLMM pair (`swap2`, empty RemainingAccountsInfo, bin arrays as remaining accounts). It builds nothing else: the caller adds the output account (idempotent), the compute limit, the transaction and the trader's signature. Optional accounts are passed as the program's own address, as the real swaps do.

Tests check discriminator, account order and writability against `idls/cp_amm.json` and `idls/lb_clmm.json`, and that the DLMM instruction is byte for byte the one the A3 proof's real devnet swap sent (data and all 17 accounts).

## Limits, stated

A DLMM mint with a transfer hook needs hook accounts in RemainingAccountsInfo; the API refuses such a swap with a reason rather than send one that would fail. Native SOL is not wrapped. A bin array outside the pair's own bitmap range (-512 to 511) needs the bitmap extension account; refused.
