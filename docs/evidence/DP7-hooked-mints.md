# DP7 — Wallets and aggregators with hooked mints (partial, 2026-10-05)

## Jupiter routing (done)

Mainnet AAPLx (`XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, Token-2022) was read with
`getAccountInfo`. It carries `transferHook` (program unset, so inactive), `permanentDelegate`,
`pausableConfig`, `scaledUiAmountConfig`, `defaultAccountState`, `confidentialTransferMint` and
`metadataPointer`/`tokenMetadata`.

Jupiter quote, 2026-10-05T19:29:03Z, context slot 453673154: 100 USDC → 29.842808 AAPLx via
Whirlpool. Jupiter routes a mint carrying the transfer-hook extension when the hook is unset.

## Not yet verified

- **Routing with an active hook.** Our gated mints set `cross_gate` as the hook. Devnet now has such a mint and a live DBC
  pool whose swaps run `cross_gate` as the hook (`A1-dbc-continuation-devnet.md`), but Jupiter does not index devnet, so
  aggregator routing of an active-hook mint can only be checked on mainnet after L4: NOT VERIFIED.
- **Wallet display.** How Phantom and Backpack show a gated mint, including a blocked transfer,
  needs a human with the wallets installed. The devnet gated mint exists; the check is a step in HUMAN_TASKS H14.
