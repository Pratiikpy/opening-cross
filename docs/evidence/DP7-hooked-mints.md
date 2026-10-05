# DP7 — Wallets and aggregators with hooked mints (partial, 2026-10-05)

## Jupiter routing (done)

Mainnet AAPLx (`XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, Token-2022) was read with
`getAccountInfo`. It carries `transferHook` (program unset, so inactive), `permanentDelegate`,
`pausableConfig`, `scaledUiAmountConfig`, `defaultAccountState`, `confidentialTransferMint` and
`metadataPointer`/`tokenMetadata`.

Jupiter quote, 2026-10-05T19:29:03Z, context slot 453673154: 100 USDC → 29.842808 AAPLx via
Whirlpool. Jupiter routes a mint carrying the transfer-hook extension when the hook is unset.

## Not yet verified

- **Routing with an active hook.** Our gated mints set `cross_gate` as the hook. That needs a
  mainnet or devnet mint with an active hook and a listed pool, which waits on the devnet upgrade
  (H10). The same check then repeats on mainnet after L4.
- **Wallet display.** How Phantom and Backpack show a gated mint, including a blocked transfer,
  needs a human with the wallets installed. The devnet gated mint is created once H10 lands. The
  check is a step in HUMAN_TASKS H14.
