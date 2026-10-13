# ADR-0484: Alpha Vault entry into a batch-opened pool (X13, R2)

Status: accepted (2026-10-13) · Builds on ADR-0483

## Decision

An Alpha Vault bound to a batch-opened DAMM v2 pool lets people who missed the cross deposit quote during a window and buy base before the pool opens. `packages/adapters/src/alphavault.ts` builds the vault (pro-rata or first-come), the depositor's escrow and deposit, the permissionless fill and the claim and refund instructions from the program's IDL. No `cross_settle` instruction is needed: the vault is permissionless and the pool is the adapter's own.

Facts found by running the real binaries, which the builders and the tests encode:

- DAMM v2 requires an Alpha Vault pool to start between one hour and 31 days away; the vault buys in the hour before the start; deposits close five minutes before that.
- DAMM v2 records only the one vault derived from the pool and **the account that created the pool**. The vault's `base` signer must therefore be the issuer that seeded the pool (`vault base == pool creator`); any other base is refused with `InvalidPool`.
- Before the start a public swap is refused (`PoolDisabled`); the vault's fill succeeds, spends its cap, and a second fill is refused.
- Pro-rata mode scales every depositor equally: deposits of 9 and 3 against a cap of 8 produced base shares in the ratio 3:1 to within rounding and returned exactly 3 and 1 of quote.

## Not built

`fill_dlmm` (the DLMM fill) and the merkle-whitelisted modes. The FCFS vault builder exists but has no test.
