# W2D-X1: weekly reopen generator and unlock logic (X1, V2, C2)

Outcome: **BUILT-LOCAL**. Design: ADR-0462, ADR-0456, ADR-0455.

`weeklyReopenSessions` generates a calendar's sessions (09:30 to 16:00 New York converted to UTC across the daylight-saving change, first session of each trading week or every trading day, up to 64) with a computed US holiday rule set; the series scheduler spawns the reopen at each session start; a halted week does not print and the authority's resume cross prints, lifts the halt and feeds lenders; an unlock is released and sold in the next reopen (`rules-stocks.test.ts`, 3 tests; `stocks.test.ts`, 11 unit tests including the 2026 holidays and the March and November clock changes).

NOT VERIFIED: the default holiday rule set against the exchange's published calendar (a caller can pass an explicit list); early closes are not modelled. Not covered: a lender's use of the feed; mainnet.

FEATURE_STATUS.md row wanted (replace the X1, V2, C2 row): `| X1, V2, C2 weekly reopen and unlock crosses | BUILT-LOCAL | Weekly calendar generator, series scheduler on the calendar, halt and resume, print feed, unlock release sold in a reopen (`W2D-X1.md`, ADR-0462) | Holiday rules not verified against the exchange's calendar; early closes not modelled; nothing on mainnet; no lender integration; DP10 found a uniform-price call auction for xStocks already exists (Uncross); devnet proof pending funding; not audited |`
