# B1 web wave: replay, receipt, export, list summary, final-window notice, schema (2026-10-13)

Rows: S12, S2, S1 (the honest part), M1, VM5, O2, R10, M10/M11. B1 (sniper figures) has its own file, `B1-sniper-simulation.md`.

Run against the live devnet API (`https://98-87-59-136.sslip.io`) from a local build of `apps/web`. Real data only: cross `5UfrmxAv…` (3 open bids, cleared at 1.2, 2 of 3 filled), the no-print cross `HaoQFsby…`, and wallet `DTB3Jtxb…` (327 orders, 70 crosses).

## Commands and results

| What | Command | Result |
|---|---|---|
| Web unit tests | `pnpm --filter ./apps/web exec vitest run` | 26 files, 285 tests pass (new: `replay`, `receipt`, `export`) |
| Web typecheck | `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` | clean |
| API route tests | `cd services/api && pnpm exec vitest run test/crosslist.test.ts` | 12 pass; typecheck clean |
| Schema vs live proofs | `cd packages/verifier && pnpm exec vitest run schema` | 22 pass: 4 captured proofs, 14 broken documents refused, and the proof of every Live/Cleared cross plus the newest 8 Finalized fetched from the live API (15 at the time) |
| Browser run | `WALLET_KEY=<keypair> BASE_URL=http://localhost:3411 node e2e/replay-receipt-export-check.mjs` | 277 PASS, 0 FAIL (`screens/b1/run.log`) |
| List in summary mode | `FILTER_ONLY=1 EXPECT_SUMMARY=1 BASE_URL=<web built against the stand-in below> node e2e/replay-receipt-export-check.mjs` | 9 PASS: 58 open + mint crosses, equal to the per-cross truth, with 0 per-cross reads from the browser |

The browser run covers, in light and dark at 1440 and 390: `/replay`, the replay tab, the cross and wallet receipts, `/export`; the final-window notice in two themes/sizes; the crosses list. Per page: zero console errors and failed requests, no horizontal overflow, axe-core with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` clean, every pointer target at least 24 by 24 px (shared header, footer and inline links excepted), focused controls not hidden under the sticky header. Screenshots, all read: `docs/evidence/screens/b1/*.png`.

## What each row now does

- **S12 replay.** `/replay` lists crosses of the last 7, 30 or 90 days with outcome, order and wallet counts and measured gaps (first order after open, cleared after close, finalized after clearing). The cross page has a Replay tab: events in order with block time, slot, transaction link to the devnet explorer, a running tally, limit prices placed so far (sealed orders never shown until revealed), Play, Pause, step, first, last, speed, a slider, and keys on the player (Space, arrows, Home, End). The full ordered list of events is the text version. Checked: 9 events listed for the 9 the API returns; ArrowRight/Left, End, Home, Play to the last event and stop; the link equals the real signature.
- **S2 receipt.** `/receipt/<cross>` and `/receipt/<cross>/<wallet>` with `/image` (PNG, `og:image`), `/json` (canonical bytes). Copy link, download PNG, download JSON. Checked: the hash on the page equals `sha256sum` of the downloaded JSON and the `x-receipt-sha256` header; `proofSha256` equals an independent computation over the live proof; price, matched, verdict equal `/proof`; an unsettled cross answers 409 / a "Not settled yet" image; a no-print cross yields a no-print receipt.
- **S1.** Final-minutes notice with a real countdown (last quarter of the call, at most 10 minutes), saying it is a display rule and that the program has no hidden or coarse window. An open order's limit and size are now taken from the index when it has them.
- **M1.** `GET /v1/crosses/summary` (`services/api/src/routes/crosslist.ts`) and the list uses it, with the old lazy reads as fallback when the API does not serve it.
- **VM5.** `packages/verifier/schema/{fairness-proof,receipt}.v1.schema.json`, tests above, `docs/standard/receipt-v1.md`.
- **O2.** `/export` table and `figures.csv` / `figures.json`: every figure with value, unit, sample size and sample unit, method, source; JSON adds the raw source answers. Link added to the home "Measured so far".
- **R10.** `/export`: connected wallet's orders as CSV (placement and settlement time and transaction, tokens and raw atoms, fill, paid, refunded, received, fee), a not-tax-advice notice above the button and on every row. Checked with wallet `DTB3Jtxb…`: 327 rows = the 327 orders the API lists; a settled row has its placement time and a 64+ character signature.

## Findings

- `/v1/owners/:owner/orders` already returns `price` and `quantity` for open (unsealed) orders: the indexer reads them from the commit instruction (`services/indexer/src/order-terms.ts`). `my-orders.tsx` ignored them for orders still open on chain; it now uses them. FEATURE_STATUS S1 ("the API does not serve it for open orders") is out of date. NOT VERIFIED live for an order that is open right now: no cross was open to place one in; verified on settled orders, by unit tests, and by reading the ingest path.
- The list endpoint is the only one without disclosure and supply mode; `GET /v1/crosses/summary` is not deployed on the live API, so the live site runs the fallback until it is. The summary mode was run against a local stand-in that executes the real route code over rows built from the live API (disclosure and supply mode read from each live cross).
- The first browser runs found and the final run fixed: a Play button with invisible text, 22 px copy buttons, 20 px links in the proof card, an export that stopped at 60 crosses.
- The browser logs each 429 or 503 the public RPC returns on the lazy list reads and the export's cross reads, which the pages retry by design. Those lines are excluded in two checks and said so in the check names.

## Not covered

- Live production deployment: nothing was deployed. The receipt image routes need `next/og`; checked in `next dev` only, not on Vercel.
- An order open right now (S1 price from index), a sealed cross's replay and receipt (no sealed cross with events in the 30 day window was exercised in the browser; the sealed rules are unit tested).
- Safari and Firefox; screen reader behaviour (the live regions and keyboard model are tested with Chromium only).
- Receipts are hash-bound, not signed; no on-chain anchoring of the receipt hash.
- The export reads at most the 500 orders the API serves per wallet; it says so when it hits that number.
