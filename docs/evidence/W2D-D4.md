# W2D-D4: greenshoe, proved on LiteSVM

Status: **proved on LiteSVM against the real DLMM limit-order binary; devnet proof pending funding.** ADR-0487. Test: `tests/core/test/settle-greenshoe.test.ts` (2 tests) plus `greenshoe::tests` in the program (3 unit tests).

Run: a finalized cross, a DLMM pair opened at P* by `open_dlmm_pair`, a 3,000,000,000-atom budget.

- Refused: a budget under 10% of what buyers paid (`GreenshoeBudget`), a start in the past (`GreenshoeWindow`), a creator who is not the cross's, a bid in the wrong level's bin or in the active bin (`GreenshoeBin`), a level that does not exist or is placed twice (`GreenshoeLevel`), an oversized or zero amount (`GreenshoeBudget`), a third level inside the same rate-limit period (`GreenshoeRateLimit`), any exit before the week ends (`GreenshoeNotExpired`).
- Placed: levels 0 and 1 in one period, level 2 after the period rolled; the vault ended at zero because the whole budget was committed.
- Filled: a seller sold 2,500,000,000 base through the three bids and received 2,564,922,416 quote, no better than 0.90 of P* per unit.
- Settled: after the week each level was cancelled by a stranger once (a second settle is refused), the program's base account held 2,497,343,746 base, `finish_greenshoe` burned all of it (mint supply fell by exactly that) and returned 435,077,584 quote to the issuer's proceeds; the sale proceeds plus the refund equal the 3,000,000,000 budget; finishing twice is refused.

Not covered: insiders cannot be kept out of the counterparties (stated in the ADR); no TWAP trigger; a mint with the cross_gate transfer hook (the settle builder passes the hook accounts but the test used a plain Token-2022 mint); DLMM pairs with a bitmap extension; devnet.
