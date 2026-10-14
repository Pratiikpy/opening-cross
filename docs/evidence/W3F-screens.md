# W3F: the screens the PARTIAL rows still lacked

Date: 2026-10-14. ADR-0750 to ADR-0754. The extended programs are proved on LiteSVM and a local validator and are NOT deployed to devnet (H27). Every screen builds its transaction through the real routes (W3A, W3E) and is judged by decoding what the wallet signed; nothing here ran against a program that has the new instructions, and no state advances after a transaction.

## What was built

| Surface | What a person gets |
|---|---|
| `/series`, `/series/:address`, calendar, cross page | Every recurring series, its schedule, the state it is in, when the next cross closes, whether anyone may spawn it now (the program's own rules, with the reason when not), how each spawned cross ended (price, or why it did not print), spawn by any wallet, pause, resume and withdraw by the authority. A cross of a series says so. |
| `/issuer/series` | Create a series (interval or calendar, open or sealed, relative or fixed grid, guards, fees, hard-to-game ending), list the wallet's series, open one. |
| `/halts/:mint`, `/issuer/halts`, cross page banner | Whether a token is halted, by whom, since when, what lifts it; the corporate-action flag; the lender print feed. The console creates a halt state (venue signer, circuit breaker), halts, flags and clears a corporate action, copies a pause, feeds the breaker, creates and updates the print feed. A cross that honours a halt that is up says so. |
| `/arbiter` | Who the arbiter is, the challenges waiting, the ruling (reject, or uphold with a slash up to the bond) with what it does with the money, closing an unanswered challenge, naming the arbiter (admin). |
| Treasury page, wind-down | The four steps with state and countdown, what the coins redeem for, redeem, trigger a liquidation, sweep, in every state. |
| Treasury page, holder extras | Open a proposal (hash of the reasons made in the browser), add to the pot, pay a revenue round. |
| `/issuer/settle` | Open the market (DBC continuation, DAMM v2 plain, batched, with an Alpha Vault, locked; DLMM plain, batched, badged; Raydium), Alpha Vault, Met Lock, Dynamic Fee Sharing, and why the DBC fee bridge is not offered. |
| Cross page, orders | Send refunds (B5); a pegged order, "Take whatever the open prints" (Z3). `/orders`: where a released lock can be sold (V7). |
| `/dashboard` | Every section of `GET /v1/dashboard` beside its source; failed, stale and missing shown as such. |
| Phone | The series and halt notes and the pegged order on the cross screen. |

## Verification run (one run, after the last code change)

| Check | Result |
|---|---|
| `apps/web` vitest | 58 files, 626 tests passed (new: `w3f-series` 21, `w3f-halts` 15, `w3f-arbiter` 8, `w3f-winddown` 10, `w3f-refunds` 8, `w3f-holder-treasury` 8, `w3f-settle-open` 17, `w3f-dashboard` 7, `w3f-lock-sale` 3, `w3f-peg` 2) |
| `apps/mobile` vitest | 6 files, 71 tests passed (new: `schedule.test.ts` 7) |
| `tsc` web, mobile | clean |
| `next build` (one, `NEXT_DIST_DIR`) | succeeded; `/series`, `/series/[address]`, `/halts/[mint]`, `/arbiter`, `/dashboard`, `/issuer/series`, `/issuer/halts` are in the route table |
| Browser, `e2e/w3f-series.mjs` | 57 checks |
| `w3f-arbiter.mjs` | 35 |
| `w3f-halts.mjs` | 43 |
| `w3f-winddown.mjs` | 42 |
| `w3f-refunds.mjs` | 13 |
| `w3f-treasury.mjs` | 18 |
| `w3f-settle.mjs` | 46 |
| `w3f-orders.mjs` | 6 |
| `w3f-dashboard.mjs` | 28 |
| `w3f-peg.mjs` | 6 |
| `w3f-visual.mjs` | 22 states x 4 views (1440 and 390, light and dark) = 88: axe WCAG 2.1 A and AA, no horizontal overflow, no console error, page error or failed request |

Total 382 browser checks, 0 failed. The harness is `services/api/test/w3f-harness.ts` (the real `buildServer`, a PGlite index with the real migrations, an in-memory chain, a JSON-RPC endpoint that records and decodes every signed transaction and verifies every signature). Run it with `W3F_PORT=8291 npx tsx test/w3f-harness.ts` in `services/api`, the app with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_RPC_URL` pointing at it, then each `e2e/w3f-*.mjs`. One isolated context and one disposable key per person.

## Defects the runs found, and fixed

1. The series authority's withdrawn balance never refreshed after a withdrawal (the read did not depend on the series read), so a second withdrawal compared against a stale or empty balance.
2. A withdrawal above what the series holds was accepted by the page and by the API; the page now refuses it with the balance.
3. A print feed update with the minimum left empty would have reset the feed's minimum to nothing; the form now starts from the feed's own minimum.
4. A DLMM Token Badge was typed as an address, but the route takes a yes or no per token and derives the account; the form is two switches and the API names a missing badge.
5. The series page, the calendar and the halt page logged a 404 in the console for an address that is not one of them; each now asks the list first.
6. The no-wallet state of an action hid the page's own reason it was off; it now shows both.
7. The fee-sharing form scolded a blank first row from the start.
8. Harness (not product): `GET /v1/programs` is cached for ten minutes, so switching the harness to the first release changed nothing until the API clock was moved; the calendar route's circuit breaker opened on a cold first read; a datetime box is read in the browser's zone (UTC), not the script's.

## Not covered

- No new instruction has run on a cluster. The browser runs prove the transaction a person signs, not what the program does with it. Instructions of Meteora's Alpha Vault, Met Lock and Dynamic Fee Sharing programs are named by program id only: the harness decodes the three programs of this repository.
- Settle: a DAMM v2 position's vesting schedule (`lock.vest`) is not offered; the DLMM Alpha Vault fill is not built; the DBC creator and partner fee bridges are not built (ADR-0701); the Alpha Vault's fill, claim and withdraw refusals were driven, not their success against a vault that holds funds.
- A series on a calendar can be spawned only when the calendar's sessions can be read; the calendar route was driven with a calendar of two sessions.
- Arbiter: challenges are found on cleared crosses the index lists (up to 60) and on a cross named by address; `GET /v1/arbiter` and `challenge-state` exist but no route lists open challenges across crosses.
- `/orders` V7 lists the crosses of the same token; selling is the order ticket's, driven in `w3f-peg.mjs` for the pegged price and not for a lock-specific flow.
- Refunds: orders that are refund-only because of a draw or a lottery are left to `claim` and to the keeper.
- R11, the operations console: no screen. It is a Postgres-backed service with issued tokens (H34).
- D9 liquidity health and the preset registry L2: no API route serves D9, so there is no page.
- Mobile: type-checked and unit-tested; not run on a device or an emulator. The refund, wind-down, series and arbiter screens are web only; the phone app has no treasury or calendar screen.
- Regression: the W3B browser suites (`issuer-w3b-*.mjs`) were run against their own harness after this work; they fail on the first-release states and on the expectation that the API does not report `cross_settle`, because `GET /v1/programs` is now registered by `server.ts` with a ten-minute cache and reports `crossSettle`. The harness of W3B does not move that cache. Not changed here: W3B's files.
