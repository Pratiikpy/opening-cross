# ADR-0910: Alpha Vault on a DLMM pair, first-come caps and the depositor's exits (X13, R2, V-D)

Status: accepted (2026-10-16) · Builds on ADR-0483, ADR-0484, ADR-0701

## Context

ADR-0484 built the Alpha Vault for a batch-opened DAMM v2 pool and listed what it did not cover: the DLMM fill (`fill_dlmm`), first-come mode (builder written, never run), a depositor changing their mind (`withdraw`, `close_escrow`), and the API routes, which had only ever been driven against account bytes held in memory.

## Decision

- `fill_dlmm` is built (`buildAlphaFillDlmm`, `packages/adapters/src/alphavault-dlmm.ts`): the vault buys base from the bins above a batch-opened DLMM pair's active bin before the pair opens. The pair must have been opened with `batch.alphaVault`; DLMM then admits only the vault derived from the pair's creator before the start, which is why the vault's base key is the cross creator, as for DAMM v2. The bin arrays the purchase walks must exist and are passed in; the API takes them from the chain (the arrays from the active bin's up, as many as exist, at most four) and says `NO_LIQUIDITY` when there are none. A transfer-hook base adds the cross_gate accounts and a `TransferHookX` slice.
- `buildAlphaWithdraw` and `buildAlphaCloseEscrow` are built, with the routes `alpha-vault-withdraw` and `alpha-vault-close-escrow`.
- The vault routes work on either venue: `alpha-vault-init` takes `venue: "damm" | "dlmm"` (default `damm`), and the other routes find the vault wherever it is.
- Every route is run against the real `alpha_vault`, `cp_amm` and `lb_clmm` binaries on LiteSVM (`meteora-routes-alpha.test.ts`), not only against account bytes.

## Facts found by running the real binaries

- A first-come vault clamps a deposit to the room left under the wallet's cap and the vault's cap, and answers `DepositAmountIsZero` when there is none. A wallet that asked for 4,000,000,000 against a cap of 3,000,000,000 was charged 3,000,000,000. The API refuses with the room (`OVER_CAP`, `OVER_WALLET_CAP`) instead of charging less than was asked.
- First-come vaults refuse `withdraw` (`VaultModeIsIncorrect`). Pro-rata `withdraw` clamps to the escrow (asking for more takes everything and says nothing); the API asks for the real figure (`OVER_WITHDRAW`).
- After the vault has bought, `withdraw` finds nothing to take (`WithdrawAmountIsZero`); `close_escrow` is refused while the escrow still holds a deposit or an unclaimed share (`EscrowIsNotClosable`) and works once the share is claimed; a closed escrow no longer exists (`AccountOwnedByWrongProgram`).
- **A bug the real program exposed in an existing route.** `alpha-vault-withdraw-remaining` refused the first refund of an oversubscribed vault because it read the vault's `total_refund` as "how much is refundable". `total_refund` counts what has been refunded so far, so it is zero until the first refund. The route now compares the vault's deposits with what it spent, and reads the escrow's own `refunded` flag. The in-memory route tests set `total_refund` by hand and could not see it.
- **A second bug of the same kind.** The route's `ESCROW_DISC` was Met Lock's, not the Alpha Vault's; it was used only to decide whether an escrow existed. The Alpha Vault's escrow discriminator is now its own constant.

## Not covered

Merkle-whitelisted vaults, the Dynamic AMM v1 fill, a hooked quote token, a hooked base through `fill_dlmm` (the accounts are built and not exercised), a pair whose bin arrays span more than four arrays above the active bin, and any run on a cluster (H27).
