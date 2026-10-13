# Final audit (2026-10-12)

A completeness and quality audit of the whole repository: the specification against the code, the documentation against the evidence, every published command run as a stranger would run it, and every page of the web app. Each defect found is listed with the file that fixed it. What was not covered is listed at the end; nothing in this file is marked done that was not run.

Working-tree changes only; nothing here is committed.

## 1. What was checked

### Specification against code (Task A)

- `PRODUCT_FEATURES.md`: all 18 modules, sections 1 to 3 (definition, rules, claims), section 19 (superseded) and section 20 (open items), row by row against the program sources, clients, services, apps, ADRs and evidence files. Result: [`docs/FEATURE_STATUS.md`](../FEATURE_STATUS.md) (built, partial or not built per row, with the gap named).
- `docs/ROADMAP.md`: every evidence link opened (all exist), and the figures quoted in the rows compared with the files they cite (15 or more figures across the sections). Five did not match and were corrected (section 2 below).
- Claims the specification says must never be made (section 3): the README, docs, web pages, MCP server, package READMEs and examples were searched for them. No hit for "provably fair", "0 snipers", "first launch auction", "first stock-quoted", "no bots" or "guaranteed". Three statements were reworded (section 2).
- Section 19 (not doing): nothing on the list is implemented or advertised. Two contradictions with the code were found and fixed in the text (three-item navigation; "holders vote to graduate", which is not built).
- Code sweep for `TODO`, `FIXME`, stubs, mocks, placeholders, "not implemented", "coming soon", fake or hard-coded sample data, across programs, crates, packages, services, apps, tests, examples and scripts (not `research/`, `node_modules`, `target`). No stub or unfinished code path was found. The only hard-coded sample data are the landing page's two illustrations, both visibly labelled; the sample proof on the landing page is now labelled as illustrative.
- Routes: every web route is linked from somewhere and reachable; every API route is used by a client or by a test. One API route (`/v1/owners/:owner/orders`) was used only inside a single cross page; it now backs the My orders page.
- Environment variables: every variable the five services, the MCP server, the web app and the mobile app read was extracted from the entry points and checked against the documentation. None was documented in one place and some were documented nowhere; see [`docs/CONFIGURATION.md`](../CONFIGURATION.md).
- Links: every relative Markdown link and every backticked repository path in the README, `docs/`, the package, service and app READMEs, `PRODUCT_FEATURES.md`, `BUILD.md` and `ENGINEERING_PRINCIPLES.md` was checked by script. After the fixes there is no broken link. External links on the site (wallet downloads) answer 200; the repository links do not for a stranger (H21).

### Commands run as a stranger (README, developers page, package READMEs)

| Command | Where | Result |
|---|---|---|
| `pnpm install --frozen-lockfile` | clean copy of the tree on Linux (WSL) | PASS, 30.9 s; pnpm lists ignored build scripts (`utf-8-validate` and similar) that it asks the user to approve; nothing needs them |
| `pnpm -r typecheck` | clean copy and the working tree | PASS, no error |
| `pnpm --filter @opening-cross/verifier verify ps6kAXQF… --rpc https://api.devnet.solana.com` | clean copy | PASS, exit 0, `"verified": true` (a real cleared devnet cross) |
| `pnpm --filter @opening-cross/verifier conformance` | clean copy | PASS, 525 cases, 0 failures |
| `pnpm test` | working tree | PASS: web 64, api 8, mcp 9, verifier 10, authenticity 21, premium 21, promises 41, sdk 4, router 5, adapters 13, token-safety 10 |
| `cargo fmt --all --check` | working tree | PASS |
| `sh examples/ts-quickstart/run.sh` | working tree, after the programs were built | PASS: packs four packages, installs only the tarballs in a fresh project, typechecks and runs a full sealed cross; ends `fairness proof: verified=true state=Finalized` |
| API started without its variables | clean copy | PASS: prints `DATABASE_URL and RPC_URL are required`, exit 2, as `docs/CONFIGURATION.md` says |
| `sh scripts/onchain-hash.sh <id> target/deploy/<name>.so devnet` | all five programs | PASS: MATCH for every program (`L4-verifiable-build.md` section 3) |

Commands that failed for a stranger and were fixed: `npx opening-cross-verify <cross>` and `npx opening-cross-conformance` (the packages are not on npm, so `npx` returns 404; the landing page and the developers page told readers to run them), and `npm install @opening-cross/...` in nine package READMEs.

### Web app (Task C)

Surfaces and states exercised, on a local Agave 4.0.2 validator with Postgres, the real indexer and API, and the built app (`next start`):

- Every route, light and dark, 1440 and 390 px, with axe (WCAG 2.0 and 2.1 A and AA), console, page-error, failed-request and horizontal-overflow checks (`apps/web/e2e/visual.mjs`): `/`, `/crosses`, `/orders`, `/issue`, `/developers`, `/status`, `/accuracy`, `/premium`, an open cross, a sealed cross awaiting settlement, and an unknown path. All clean except the browser's own 404 console line for the unknown path.
- Site-level checks (`apps/web/e2e/site-flow.mjs`, new): robots, sitemap, manifest, icon, Apple icon and Open Graph image are served; every page has a specific title, description, Open Graph and Twitter tags, an icon, `lang="en"` and exactly one `h1`; the 404 page and its axe result; the skip link; the header's three destinations and a visible focus ring; the wallet dialog (opens, Escape, backdrop click, the no-wallet message); the orders page without a wallet; the mobile menu (lists the trust pages, closes on Escape, on choosing a page and on an outside click); no horizontal overflow on the mobile developers page. 49 checks, all PASS.
- Investor flow (`investor-flow.mjs`), two isolated users with real Wallet Standard wallets, every transaction built by the API and signed in the page, outcomes read from chain: off-grid and malformed inputs, wallet decline, escrow, cancel and refund, sealed bid and backup restore after a storage wipe, reveal, settle, claim, pro-rata fills, 390 px dark mode, zero console errors. New in this pass: the My orders page after two real claims. ALL PASSED.
- Issuer flow (`issuer-flow.mjs`): ALL PASSED.
- Trust flow (`trust-flow.mjs`) and the stranger's `promises verify`: see section 4.
- Not looked at in a browser: the unit tests cover long and extreme numbers (largest on-chain amount, 18 decimals, malformed and non-ASCII digits, zero-decimal mints); right-to-left text was not exercised (the app is English only).

## 2. Defects found and fixed

### Web app

| # | Defect | Fix |
|---|---|---|
| 1 | The mobile menu stayed open after choosing a page and did not close on Escape or an outside click | `components/nav.tsx` (`useDismissableDetails`), `site-header.tsx` |
| 2 | The connected-wallet popover had the same problem | `components/wallet-button.tsx` |
| 3 | The wallet dialog did not close on a click outside it | `components/wallet-button.tsx` |
| 4 | No indication of the current page in the navigation | `components/nav.tsx` (`aria-current`, underline) |
| 5 | Seven header destinations against the specification's limit of three | `components/nav-items.ts`, `site-header.tsx`, `site-footer.tsx`, mobile menu; the trust pages moved to the footer, the mobile menu and the landing page |
| 6 | The Buy and Sell control was a pair of buttons with `role="radio"` and none of the radio keyboard behaviour | `components/cross/order-ticket.tsx` (native radio inputs) |
| 7 | The order book showed quantities only in hover tooltips, so touch, keyboard and screen-reader users saw bars with no numbers | `components/cross/book-chart.tsx` |
| 8 | Issuer number fields displayed `NaN` when cleared or mistyped | `components/issuer/issuer-console.tsx` (`Num`) |
| 9 | Editing a mint address left the previous mint's decimals in use until the check button was pressed again | `components/issuer/issuer-console.tsx` (invalidate on change, check on blur) |
| 10 | The issuer form explained none of its choices (sealed or open, supply mode, kind, guards) and tied its error text to nothing | `components/issuer/issuer-console.tsx` (hints and `aria-describedby`, outside the label so the accessible name stays short) |
| 11 | The cross page headline showed a bare dash that rendered as a black bar, and said "Price if it closed now" after the call had closed | `components/cross/cross-view.tsx` ("Sealed", "No price yet", "Price once it settles"; indicative note matches the phase) |
| 12 | The price card stretched to the height of the order column, leaving a large empty block | `components/cross/cross-view.tsx` (`items-start`) |
| 13 | No page listed a wallet's orders across crosses | new `app/orders/page.tsx`, `components/orders/my-orders-page.tsx`, `lib/orders.ts` (3 tests), link in the wallet menu and footer |
| 14 | Money values in fill reports had no unit; order headings capitalised every word (introduced and caught in the same pass) | `components/orders/my-orders-page.tsx`, `components/cross/my-orders.tsx` |
| 15 | No designed 404 or error page | new `app/not-found.tsx`, `app/error.tsx` |
| 16 | No Open Graph or Twitter metadata, canonical base, sitemap, robots, manifest, Apple icon or share image | `app/layout.tsx`, new `lib/site.ts`, `app/robots.ts`, `app/sitemap.ts`, `app/manifest.ts`, `app/apple-icon.tsx`, `app/opengraph-image.tsx` |
| 17 | Landing page and developers page told readers to run `npx opening-cross-verify` (404 on npm) | `app/page.tsx`, `app/developers/page.tsx`, `packages/verifier/package.json` (new `verify` and `conformance` scripts), `packages/verifier/README.md` |
| 18 | "at exactly the clearing price" for pools (DLMM opens within half a bin step); "Nothing to take on trust. Everything is public." beside a single upgrade key and no audit; "525 published test vectors" when the repository is private | `app/page.tsx` |
| 19 | "Run a full cross in five minutes" (the first program build takes several), no prerequisites listed, "open source" while the repository is private | `app/developers/page.tsx` |
| 20 | The status page showed the indexer as OK whenever the API answered, which proves nothing about the indexer | `app/status/page.tsx` (renamed "Indexed data", says what it does and does not prove) |
| 21 | A scrollable code block that could not be reached by keyboard; a full page reload on an internal link; the "a cross is open now" badge was not a link; the sample proof on the landing page was not visibly labelled | `app/accuracy/page.tsx`, `components/cross/signed-band.tsx`, `app/page.tsx` |
| 22 | A regression I introduced while fixing 7 (an `aria-label` containing "tokens" made the e2e label lookup ambiguous), caught by the investor flow before it was kept | `components/cross/book-chart.tsx` |
| 23 | `apps/web/package.json` described a portfolio that did not exist | `apps/web/package.json` |
| 24 | On the cross page the panels that load after the page (signed band, identity check) were inserted above the order form and pushed it down (layout shift 0.115 on desktop), and the identity note, a full card of text on every non-mainnet network, was the largest element on a phone and made the page's mobile LCP 2.9 s against the 2.5 s budget | `components/cross/cross-view.tsx` (the order form, settle prompt and wallet prompt now come first; the late panels go below), `components/cross/identity-panel.tsx` (the not-comparable note is one small line) |

### API

| # | Defect | Fix |
|---|---|---|
| 25 | No rate limiting or abuse control on a public API (an open gap in the threat model) | new `services/api/src/rate-limit.ts`, `server.ts`, `main.ts`; 5 tests in `services/api/test/rate-limit.test.ts`; documented in `docs/CONFIGURATION.md` |

### Documentation and evidence

| # | Defect | Fix |
|---|---|---|
| 26 | README was a file list with no explanation, architecture, evidence or integration guidance | `README.md` rewritten |
| 27 | Nine package READMEs gave `npm install` for packages that are not published | each package README (note pointing at H12) |
| 28 | ROADMAP figures that did not match their evidence: A1 `bind_dbc_mint` 53,129 CU (evidence 56,129), C2 "16/16" (15 steps), C2 upgrade signatures and byte counts that no file records, DP3 CU figures that no file records, DP14 "11/11" (10 unit tests and 2 mainnet reads), DP15 "24 to 40 days" (23 to 40) | `docs/ROADMAP.md` |
| 29 | `DP15-pyth-mainnet.md` named the devnet RPC for a run that read mainnet; the shared evidence writer printed one constant for every script | `tests/devnet/src/lib.ts` (optional endpoint label), `tests/devnet/src/oracle-mainnet.ts`, the evidence header |
| 30 | `L4-verifiable-build.md` said `cross_gate` was stale and three programs were not deployed; the treasury hash predates its new program id | re-checked all five programs on devnet (all MATCH) and rewrote sections 2 and 3; the Docker build of the treasury at its new id is marked NOT VERIFIED |
| 31 | Nine documents said a devnet run "waits on H10" (devnet funding), after those runs were made | `docs/adr/0014`, `docs/evidence/D1`, `D2-keeper`, `D3`, `D5`, `DP12`, `DP7`, `docs/security/THREAT_MODEL.md`, `docs/ROADMAP.md`, `docs/HUMAN_TASKS.md` (H10 closed, H14 reworded) |
| 32 | `PRODUCT_FEATURES.md` contradicted the code: Pinocchio (it is Anchor), a `cross_fees` program (fees are in `cross_core`), "not revealing is never a free option" (unrevealed bids are refunded), design (d) in one transaction (two steps), VM6 "open" (decided in ADR-0003), Presale Vault and partner-mint "NOT VERIFIED" (proved), the 11-invariant list (13 are enforced) with a formal proof (there is none), performance targets presented as estimates (several now measured), a headline of "what nobody else has" (DP10 found Uncross) | `PRODUCT_FEATURES.md`, new `docs/FEATURE_STATUS.md`, `CLAUDE.md` (decision 7 note), `BUILD.md` ("No product exists") |
| 33 | `ADR-0003` stated that truthful bidding is a dominant strategy; nothing in the repository proves it | `docs/adr/0003-clearing-rule.md` (marked NOT VERIFIED) |
| 34 | No document listed the environment variables the processes read | new `docs/CONFIGURATION.md` |
| 35 | The repository is private, so every link to it and the quickstart's `git clone` fail for a stranger | not fixable in code: new `docs/HUMAN_TASKS.md` H21 |
| 36 | Threat model gaps 3 and 6 were out of date | `docs/security/THREAT_MODEL.md` |

## 3. Not covered, and human-only

Human-only (each has an exact step in `docs/HUMAN_TASKS.md`):

- Make the GitHub repository public or grant reviewers access (H21, new). Until then the footer, `git clone`, package READMEs and both hackathon submissions point at a 404.
- External audit (H6), legal entity and counsel (H1, H2), mainnet deployment with caps (H18), Squads member keys (H13), registry accounts so the packages can be published (H12), paid RPC and hosting (H7, H20), wallet display of gated mints (H14), an Android device run (H19), the Arcium benchmark funding (H17), the Pyth API key rerun (H11), recruiting external users (H8).

Not covered by this audit:

- **Devnet UI run.** The browser flows ran on a local validator. The web app was not run against public devnet (the public RPC throttled bid landing to p90 17.7 s in `DP13-devnet-latency.md`).
- **Not re-run in this pass:** `sh scripts/build-programs.sh` (a full rebuild of all programs; the five deployed programs equal the existing builds byte for byte and no program source was changed), `cargo clippy --workspace -- -D warnings`, `cargo test --workspace --release`, and the LiteSVM core suite (115 tests, last recorded in `docs/PROGRESS.md`). The Docker verifiable build was not repeated for the treasury.
- **Premium monitor** outside the `closed` session, the real calibration gate (30 graded crosses over 2 days), the mobile app on a device, a hosted deployment, and a WAF.
- **Visual:** the screens were checked at 1440 and 390 px in two themes with a headless Chromium; no real phone, no Safari or Firefox, no screen reader, and WCAG 2.2 criteria beyond what axe's 2.1 rules cover.
- **Lighthouse:** see section 4 for the run that was made; mobile throttling was Lighthouse's default simulation, not a real device.
- **Sections of the specification** marked NOT BUILT in `docs/FEATURE_STATUS.md` are planned work, not defects of what exists.
- The research folders (`research/`, `meteora-resources/`, `colosseum-solana-resources/`, `ux_teardown/`) and the product film (`video/`) were not audited.

## 4. Browser runs on the final build

Run 2026-10-13 on `main` after the last code change to the web app, local validator with the freshly built programs, Postgres 17, the production build of the web app, Chromium via Playwright (`tests/e2e/run-all.sh`, modes flow, issuer and trust, one at a time):

| Run | Result |
|---|---|
| Investor flow (two isolated users, real Wallet Standard wallets, outcomes read from chain) | ALL PASSED, zero console and page errors for both buyers |
| Issuer flow | ALL PASSED |
| Trust flow, open phase and settled phase | 22 of 22 and 26 of 26 checks passed |
| Core suite (LiteSVM, indexer, API, keeper, adapters on Meteora's real binaries) | 28 files, 135 tests passed |
| Typecheck of every package, unit suites of every package | pass |
| Live smoke of the deployed site (`apps/web/e2e/live-smoke.mjs`): 11 pages x light and dark x 1440 and 390 px = 44 views | zero console errors, page errors or failed requests, no horizontal overflow, no `undefined` or `NaN` text |

Harness bug found and fixed in this pass: `tests/e2e/run-all.sh` and `run-stack.sh` trapped EXIT with `kill 0`, which re-triggered the trap forever and left every browser run hanging after it finished; both now clear the trap first. Earlier failed runs (killed by WSL restarts) were not counted.

## 5. Final pass, 2026-10-13: defects found on the live deployment

Found by looking at the deployed site and its API as a stranger, then fixed and redeployed (backend on AWS, web on Vercel):

| # | Defect | Fix |
|---|---|---|
| 37 | The premium page showed nonsense: the deployed monitor measures 38 stocks and quotes through empty pools came back at up to 9,573 times the reference, so the "Market closed" medians read +205% | A quote more than 25% from the reference counts as "no market at this size" and stays out of the medians (`packages/premium/src/stats.ts`, `apps/web/src/lib/premium.ts`, tests in both). Live medians after the fix: +0.33% (buy) and -0.30% (sell) in regular hours |
| 38 | A cross page sometimes sat on "Loading the book" because every request re-read the chain through the throttled public RPC | A finalized cross's book is cached in the API (`services/api/src/server.ts`); first read about 4 s, later reads under 1 s |
| 39 | A cross whose order-book account was never created (a stranded cross) made `/book` answer 404, which the page logged as a console error | The API returns an empty book with a note (`services/api/src/server.ts`); the live smoke now passes with zero console errors |
| 40 | The keeper logged a failure for the same stranded cross every 30 seconds | Reported once per pass as skipped (`services/keeper/src/keeper.ts`) |
| 41 | `/v1/stats` counted only state `NoPrint` as "did not print", so the landing tile read 0 while 10 finalized crosses had no price | Counts finalized crosses with no clearing price too (`services/api/src/server.ts`); live value now 10, equal to an independent count |

### Found by the last live run (2026-10-13, after the second wave of features)

| # | Defect | Fix |
|---|---|---|
| 42 | A buyer whose wallet held less quote token than the order locks saw only "Transaction simulation failed: custom program error: 0x1" | The order ticket reads the wallet's balance of the token the order locks and, when short, disables Place order and says how much it holds and how much more it needs (`apps/web/src/lib/balance.ts`; checked live with a wallet holding none: `e2e/shortfall-check.mjs`) |
| 44 | Under load the API answered 503 for a cross, its book or an order page while the shared public devnet RPC rate limited it, and the first read of a mint made the cross detail take 8.6 s | A bounded wait on the safety read, a metrics warm-up that retries until every cross has been read once, chain reads that retry and share simultaneous requests, settled orders answered from the index, and one book answer shared for two seconds; the real-wallet lifecycle on the live site then passed in full (`W2-live-deployment.md`) |
| 43 | The live-run harness counted a click before hydration and request cancellations on reload as failures | `e2e/live-devnet.mjs` clicks again until the wallet list opens and ignores `net::ERR_ABORTED` |

### Not covered in this pass


- Devnet: once the operator wallet was funded (10 SOL, 2026-10-13) the Meteora features added that day (DAMM v2 lock, vesting and compounding; DLMM conviction ladder; fee-sharing vault) were also proven on devnet against the live Meteora programs: `D1-damm-lock-compounding-devnet.md`, `D5-dlmm-conviction-ladder-devnet.md`, `D7-fee-sharing-vault-devnet.md`, all PASS, each with Meteora's own refusal read from the logs. Not covered by those runs: the `flat` and `wall` ladder shapes on devnet, and a compounding pool's claimable-fee split on devnet (both are covered in LiteSVM only).
- The premium monitor's Jupiter quotes are rate limited from the server (the latest rounds often price few tickers); the page says how many quotes failed.
- Programs were not changed or rebuilt; the five deployed programs still equal the repository builds.
- The second wave's claim center was not exercised with a real signed Claim all (API rate limits during the attempt); the issuer console at 390 px was not covered; the router quotes crosses only on devnet (Jupiter is mainnet-only); DP13 misses its 5 s target and DP15 fails for NVDA on a Pyth entitlement, both external and recorded in their evidence files.
