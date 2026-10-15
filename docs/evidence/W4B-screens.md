# W4B: the screens of the seven Wave 3D programs and the two batch 2 settle steps

Date: 2026-10-15. ADR-0850 to ADR-0852. The programs are proved on LiteSVM and a local validator and are NOT deployed to devnet (H27, H43). Every screen reads `GET /v1/programs`, says so when the connected cluster does not have what it needs, and switches off what the cluster would refuse. Each flow was run in a browser against a local harness serving the real unsigned transactions of the W4A routes (`services/api/test/w4b-harness.ts`); every transaction the wallet signed was verified and decoded, and the tests assert its instruction, signer, accounts and arguments. Nothing here ran against a cluster that has the programs, and no state advances after a transaction.

## What was built

| Row | Screens |
|---|---|
| D10, Z0 graduation by holder vote | Graduation tab on a governed cross (charter, every round, tallies, quorum, why a round is short, vote, post volume, finalize, publish outcome, take tokens back, outcome banner, mint-authority warning); `/issuer/graduation` (charter, rounds); the governed-graduation rule as a form field, a preset and a bidder-facing line; the settle page follows the outcome |
| B4 fixed-price tranche, X3 MetaDAO DAO | Two frames on `/issuer/settle`, each with the release notice; the price pin, the derived quote deposit, the legacy-token blocker, the fresh signing account |
| L1 stake-bonded listing | `/listing`, `/listing/[venue]` (terms, bond, list, release, slash), `/issuer/listing`, the listing badge on the cross page |
| X10 bounty | `/bounties`, `/bounties/[address]` (invariants, claim, fund, award with the report hash, withdraw, payouts), `/bounties/new` |
| F6 backing watchdog | `/backing`, `/backing/[mint]`, `/issuer/backing` (halt state with the watchdog, policy, statement), the backed badge and stale-statement banner on the cross page |
| S4, J2 mandates | `/mandates` (create with a first funding), `/mandates/[address]` (owner: fund, change limits, withdraw, revoke; agent: place and cancel; anyone: sweep), `/agents` (what a key may sign, the guard, the MCP tools) |
| S7 conviction | `/conviction` (lock with a badge preview, unlock, mint the badge, close, the badges, a token's totals) |
| S5 basket | `/baskets`, `/baskets/[address]` (what a share is, solvency, quote with rounding, mint, redeem), `/baskets/new` |
| Navigation | the seven pages in the menu and the sitemap, three issuer pages in the issuer menu |
| Phone | the cross screen shows the listing, a failing backing policy and a governed vote, read only |

## Verification run (one run, after the last code change)

| Check | Result |
|---|---|
| `apps/web` vitest | 65 files, 715 tests passed (new: 7 files, 89 tests: `w4b-graduation`, `w4b-new-programs`, `w4b-tranche`, `w4b-listing-backing`, `w4b-bounty-mandates`, `w4b-conviction-baskets`, `w4b-rules-flag`) |
| `apps/mobile` vitest | 7 files, 76 tests passed (new: `wave3d.test.ts`) |
| `packages/presets` vitest | 2 files, 27 tests passed |
| `tsc` web, mobile, presets | clean |
| `next build` (one, `NEXT_DIST_DIR`, then deleted) | succeeded; every new route is in the table |
| Browser, built app, `w4b-graduation.mjs` | 51 checks |
| `w4b-settle.mjs` | 34 |
| `w4b-listing.mjs` | 37 |
| `w4b-backing.mjs` | 34 |
| `w4b-bounty.mjs` | 40 |
| `w4b-mandates.mjs` | 56 |
| `w4b-conviction.mjs` | 26 |
| `w4b-baskets.mjs` | 29 |
| `w4b-visual.mjs` | 30 states x 4 views (1440 and 390, light and dark) = 120: axe WCAG 2.1 A and AA, no horizontal overflow, no console error, page error or failed request |
| Regression, W3F suites after the settle and cross-page changes | `w3f-settle`, `w3f-halts`, `w3f-series` all pass on the W3F harness |

Total 307 browser checks and 120 visual passes, 0 failed. Every suite ran twice over: once with the programs present and once with them absent (`POST /__mode`). Screenshots: `docs/evidence/screens/w4b/` (32 states, 256 colours). To run: harness `W4B_PORT=8390 npx tsx test/w4b-harness.ts` in `services/api`; the app with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_RPC_URL` pointing at it; then each `e2e/w4b-*.mjs` with `BASE_URL`, `API_URL` and `OUT`. Start the harness fresh for each suite: a mode switch moves the API's clock by ten minutes (to expire the release cache), and the backing fixtures age with it.

## Defects the runs found, and fixed

1. The order form of a mandate accepted a price that is exact in tokens but off the cross's grid; the API would have refused it after the wallet was asked. It is named on the form with the grid's first price and step.
2. A holder's action with no wallet said "Connect the wallet you issue from" (the issuer wording). The new actions say "Connect a wallet to sign this", or name who may sign.
3. A page for one venue, bounty, mandate or basket on a network without the program provoked a 404 that the browser logs as an error. They ask the index first (ADR-0850).
4. The bond line showed raw atoms for a moment before the token's decimals were read; it now says it is reading.
5. A basket quote kept the previous direction's lines while the other was read; the quote is marked by the answer, not by the toggle.
6. Harness, not product: the mode switch accumulated clock skew until the fixtures aged out; `networkidle` never arrived on a page with a request in flight. The first is documented above; the second is waited for briefly, not required.

## Not covered

- No instruction ran on a cluster. The browser runs prove the transaction a person signs, not what the program does with it, and no screen was shown a record created by a real indexer.
- Reveal of a sealed mandate order has no screen (`oc_draft_mandate_reveal_order` exists); a basket's address lookup table path (more than about five components) is only noted on the page; the issuer wizard's rules step gained one check and a preset, but its browser suites (`issuer-w3b-wizard`) were not re-run, only the unit tests of the rules form.
- A record created a moment ago may be absent from the index, and its page then says "not known" until the indexer catches up.
- `packages/rights-card` was not changed: its cards describe a treasury's rights, and no card fits these programs.
- Phone: type-checked and unit-tested, not run on a device or an emulator; the phone has no screen for voting, listing, bounties, mandates, locks or baskets.
- The pages were not run against a real devnet, and light and dark were read by eye on the states listed, not on every one of the 120 captures.
