# Surfpool tests

Opening Cross programs on a [Surfpool](https://github.com/solana-foundation/surfpool) surfnet: the real compiled binaries from `target/deploy`, written to their real addresses; real transactions over JSON-RPC; and a clock the test can move. Every outcome is read back from chain state, and every refusal is read from the node's own simulation with the program's own error number.

```
# 1. a surfnet (Linux or WSL; surfpool 1.6.1 was used)
surfpool start --offline --no-tui --no-studio --no-deploy -p 18899 -w 18900     # keep stdin open, or it exits
# 2. the tests
pnpm --filter @opening-cross/surfpool-tests test
```

`SURFPOOL_URL` points the suite at another surfnet (default `http://127.0.0.1:18899`). The binaries are written fresh on every run with Surfpool's `surfnet_writeProgram`, so the programs run from their real addresses and their own `declare_id!` check passes. The operator key is derived from a fixed label, so the protocol account an earlier run created still has its admin; nothing here touches a real cluster, and the key holds nothing.

| File | What it drives |
|---|---|
| `test/boot.test.ts` | the surfnet answers, `cross_core` runs from its address, the protocol account exists with the admin and fees given |
| `test/core-flow.test.ts` | a mint-mode launch with an open book and a sealed escrow-mode cross, through create, place, cancel, commit, reveal, clear, claim and finalize, compared with the independent reference implementation; the refusals between the steps (off-grid price, order or cancel after the call, claim or finalize before clearing, clearing while the call or the reveal window is open, a reveal too early, with a wrong salt and with a wrong price, a second claim); pausing by the admin and not by a stranger; the 100 bps fee cap |
| `test/calendar-timelock.test.ts` | every instruction of `cross_calendar`: the seven-day timelock is crossed by moving the surfnet's clock (`surfnet_timeTravel`), including the ten seconds before it; propose, apply (by anyone), cancel, and the admin handover; each refusal by number |

What the suites found out by running: an open-book cross refuses a cancel after the call with `NotInCallWindow` (6007), the same as a late order, not `CancelClosed` (6044); a second claim fails because the first closed the order account (`AccountNotInitialized`, 3012); and 65 sessions (the first over the calendar's limit of 64) is 1,040 bytes of arguments and cannot be sent in a transaction at all, so only the feed limit of that pair is reachable.

Not covered: the other programs (`cross_gate` has no current binary in `target/deploy`, see `tests/mollusk`), settlement into Meteora/Raydium pools (those programs are not on an offline surfnet), the keeper, indexer and API against this surfnet, and any state of a cross that needs a Pyth update or a Token-2022 extension. Surfpool is run offline, so nothing is forked from a cluster.
