# W2D-E5: mandatory disclosure feed, on-chain parts (E5)

Outcome: **BUILT-LOCAL** (on-chain parts). Proved on LiteSVM; devnet proof pending funding. Design: ADR-0475. Build record: `W2D-treasury-build.md`.

Tests (`treasury-grants.test.ts`, "disclosure feed", 2 tests):

- A non-holder cannot request (`NotHolder`); a holder's request opens a 14-day clock; a second request does not restart it; spending works inside the window and exactly at its end; one second later the team cannot spend (`DisclosureOverdue`); only the authority can post; a post clears the request, records the hash, the time and the count, and spending resumes.
- A minimum stake to request (20%: a 10% holder is refused, a 40% holder is not); both instructions are refused when the feed is off (`Disabled`).

Not built: monthly cadence enforcement (the program answers holders' requests; it does not require a post every month), a front-end feed and the indexer/API support for `DisclosurePosted` and `DisclosureRequested`, and any check of what a posted document says.

FEATURE_STATUS.md row wanted: `| E5 mandatory disclosure feed | BUILT-LOCAL, on-chain parts | `post_disclosure` (hash, time, count) and holder `request_disclosure` with an enforced deadline: team outflows are refused while a request is overdue (ADR-0475; `W2D-E5.md`) | No monthly cadence, no content check; no indexer, API or UI for the events; LiteSVM only, devnet pending; not audited |`
