# W2C-T1 (with S5): Markets tab and the cohort index

Outcomes: **T1 BUILT**; **S5 BUILT for the index, needs-program for a basket token** (a tradeable basket would be a program). Design: ADR-0409. Code: `apps/web/src/app/markets`, `components/portfolio/markets-page.tsx`, `lib/holder-markets.ts`, `lib/holder-value.ts` (`cohortIndex`).

Tokens that have cleared (59 on the live index): last clearing price and day linked to the cross, matched then, prints, and the next cross with a Follow button. Tokenized stocks: the premium monitor's latest round; when none could be priced the page says so and why instead of 50 empty rows; raw reference prices are never shown (H15). The cohort index is published only with at least three tokens that cleared more than once in the same quote token; today one qualifies (one token printed twice at the same price), so the page says it cannot show a level.

Tests: `holder-value.test.ts` (nextCrossFor, cohortIndex: equal weighting of latest over first, tokens in two quote tokens kept apart, nothing for no repeat). Browser run (`holder-pages-flow.mjs`, 390 dark, against the live index): the assets table lists tokens with prices, the index block explains itself, the stocks block renders; axe clean after one fix (two landmarks shared a name: the table regions are now "Table of …"); zero console errors. Screenshots read: `screens/w2c/markets-390-dark.png` (which also led to hiding two secondary columns on a phone and to the stocks summary).

Not covered: a "router-filled" trade between crosses (the router quotes, it does not execute: Z1); a stock with a priced premium (the monitor's latest round priced none during the run).
