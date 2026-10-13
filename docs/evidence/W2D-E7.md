# W2D-E7: withdraw-only wind-down (E7)

Outcome: **BUILT-LOCAL**, wording differs from the row ("funds pushed back" is not built). Proved on LiteSVM; devnet proof pending funding. Design: ADR-0474. Build record: `W2D-treasury-build.md`.

Tests (`treasury-dist.test.ts`, "withdraw-only wind-down", 2 tests):

- A sweep before liquidation is refused (`NotLiquidating`). After liquidation `wind_start` is stamped at the trigger time. Holders redeem (400 and 300 of 1,000 coins against a 10,000 vault pay 4,000 and 3,000) throughout the window, including on its last second; a sweep one second early is refused (`WindowOpen`); at the end a sweep to the wrong account is refused (`WrongRecovery`) and to the named recovery account moves the remaining 3,000 exactly; a second sweep is refused (`AlreadySwept`); redemption after the sweep is refused with a clear error (`WoundDown`).
- With no window configured the sweep is refused (`Disabled`) and redemption never expires.
- During liquidation, stakes, deposits, proposals and spends are refused (`Liquidating`); unstake, reclaim, claim and redeem work (`treasury-dist.test.ts`, `treasury-gov.test.ts`).
- The window cannot be shorter than 180 days (`treasury-ext.test.ts`).

Not built: pushing funds to holders (impossible without their signature to burn coins; ADR-0474), a runbook beyond the test and the devnet script, and the sweep on a real clock (180 days cannot be run on devnet).

FEATURE_STATUS.md row wanted: `| E7 wind-down | BUILT-LOCAL, wording differs | Redemption stays open for a window of at least 180 days; withdraw-only meanwhile; after it anyone sweeps the rest once to a recovery account fixed in advance (ADR-0474; `W2D-E7.md`) | Funds are not pushed to holders (cannot be: redemption burns the holder's coins); the recovery account is the team's choice; LiteSVM only, devnet pending; not audited |`
