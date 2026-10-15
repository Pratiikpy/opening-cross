# ADR-0953: Rating outcomes come from a price source, and the venture index is a forward-collected sample with bounds

Date: 2026-10-16 · Status: accepted · Implements PRODUCT_FEATURES [V5]; builds on ADR-0302 (rating v0 and its track record)

## Context
The rating feed is only worth reading if its track record is published, including when it does not beat chance. The track record needs, for each rated cross, what happened to the token afterwards, and `rating_outcomes` was an empty table with no writer. The other half of V5, a venture index "over every Solana raise", cannot be built exhaustively from free public data: the Jupiter token list's `recent` endpoint returns the newest 30 launches per request (measured 2026-10-15: pump.fun, stonkfun, met-dbc and raydium-launchlab appeared; roughly 16 to 26 of 30 were new at a 20-second poll, so a slower poll misses launches), Meteora's DBC has no public pools API (`dbc-api.meteora.ag` answers 404), and MetaDAO's API sits behind a bot check.

## Decision
`services/ratings`.
1. **Outcomes.** `resolveOutcomes` finds rated, finalized crosses with no outcome whose horizon (default seven days after the reveal window ended) has passed, reads the cross's clearing price from chain (corrected for both decimals and the price scale), reads the token's price in the cross's own quote asset an horizon later from GeckoTerminal's hourly bars for the deepest pool pairing that token with that quote asset, and writes `outcome_bps` with the pool and bar as the source. It writes nothing it could not read: no pool in the quote asset, no trade in that hour, a horizon beyond 175 days (the public API's limit) or not yet reached leaves the cross pending with the reason.
2. **Survival.** For the organic-volume bar (ADR-0954) it records whether a rated cross's token was alive 30 days after trading began (a price and at least 5,000 USD of liquidity), once, and records `missed` when the look is more than six hours late.
3. **Venture index (version 0).** A collector polls the launch feed (every 20 seconds; the `watch` command), records new launches under their launchpad from the moment they are first seen, and reads each one's price and liquidity when its 1-day and 7-day horizons fall. The index reports, per launchpad and launch week: observed, due, alive, and two bounds for survival and for the median price change (unresolved or missed launches counted dead or as a total loss, or left out) with a seeded bootstrap interval where there are five values or more. It reports how many polls came back with nothing already seen, which means launches were probably missed between polls.
4. **No survivors.** A token is never added because it still trades today. The first price is the price when the token was first seen, not a price anyone could have bought at launch, and the report says so.

## Alternatives considered
- **Back-fill from today's top tokens.** Survivorship bias would make every venue look better than it is.
- **Enumerate every pump.fun or DBC launch on chain.** Complete in principle, but `getProgramAccounts` is refused on public RPCs and a full log scan needs an indexer; the collector's interface is a feed, so a complete chain-derived feed can replace the sample later.
- **A single index level.** A cohort table with bounds is honest; a single number invites reading a precision that is not there.

## Consequences
- Until crosses run on mainnet and 7 and 30 days pass there is no outcome and no survival label, and the track record keeps saying "0 rated crosses have a recorded outcome" instead of a hit rate. The code path is complete; the evidence must accrue in time.
- The venture index's first seven-day rows exist seven days after the collector starts. It covers the venues the feed shows, not MetaDAO, not a team's own sale, and not Opening Cross itself (devnet).
- `PgRatingStore` and the two SQL reads were written against the migrations (001, 012, 019) and tested through the same interface with an in-memory store; they have NOT been run against a live Postgres here (no database was available).

## Evidence
`docs/evidence/W5-1F.md`: the collector run against the live feed (three polls, 61 launches recorded, 16 to 26 new per 30 returned); 17 tests including the outcome arithmetic, every pending reason, the no-late-reading rule and the bound arithmetic worked by hand.
