# W2C-R6: investor retention, measured by cohort

Outcome: **BUILT** (the measurement and its page). Design: ADR-0407. Code: `services/api/src/routes/holder-retention.ts`, `/retention` (`components/portfolio/retention-view.tsx`).

Cohorts are the week of a wallet's first cross; a wallet is retained in week k if it ordered in a cross that opened k weeks later; only completed weeks are reported; cross creators and `OWN_WALLETS` are excluded; a cohort under five wallets shows counts and no percentage; the method line says these are devnet test traffic.

Tests (`holder-social.test.ts`, retention part, 4): the table on a hand-built history (retained counts and rates, a small cohort with no rate, the returning share), only finished weeks and at most eight, no wallets, two orders in one cross are not a return, and the route on a real Postgres with a creator and an own wallet excluded.

Browser run (`holder-pages-flow.mjs`, 390 dark): the page rendered from the harness index (real crosses and orders of two wallets), axe clean, zero console errors; screenshot `screens/w2c/retention-390-dark.png`.

The loops that this is meant to measure (alerts, the follow list, the claim notice, the receipt) are built and none claims an effect. With devnet test traffic the figures measure no outside demand, and the page says so. The live deployment does not carry the route until `registerHolderRoutes` is wired.
