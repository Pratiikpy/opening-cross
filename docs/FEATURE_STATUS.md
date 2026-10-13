# Feature status

`PRODUCT_FEATURES.md` is the specification of the product: everything the company intends to build. This file says, row by row, what exists today. It was produced on 2026-10-12 by reading the program sources, the clients, services and apps, the ADRs and the evidence files; no test was run for it. Where a figure appears it comes from a file in `docs/evidence/` or from `docs/ROADMAP.md`.

**Status words**

- **BUILT**: working code on every layer that applies to the row, and a passing test or an evidence file that proves it.
- **PARTIAL**: some layers or some of the row's claims exist. The Gap column names exactly what is missing.
- **NOT BUILT**: no code. The reason is later roadmap, a counsel or partner dependency, or a human task (`docs/HUMAN_TASKS.md`).

IDs are the ones in `PRODUCT_FEATURES.md`. They are a different numbering from the ROADMAP's `A1`–`A5` and `C1`–`C6`, which are build items.

What is built, in one paragraph: five on-chain programs (`cross_core`, `cross_gate`, `cross_settle`, `cross_calendar`, `treasury`) deployed on devnet and equal to the local builds byte for byte; the clearing rule in `clearing-core` with an independent TypeScript verifier and 525 conformance vectors; four settlement adapters (Meteora DBC continuation, DAMM v2, DLMM, Raydium CPMM) each proved on devnet; identity gating with real SAS attestations; the ownership-coin treasury; an indexer, keepers, an API, an MCP server, a signed-promise track record and a premium monitor; and a web app and a native app. The rest of the specification is not built.

## 4. Cross core and mechanism

| ID | Status | What exists | Gap |
|---|---|---|---|
| W1, V1, B1 `cross_core` | BUILT, wording differs | Program (Anchor 1.0.2), Codama client, SDK, indexer, API, web, mobile, verifier. Devnet `C2-cross-core-devnet.md` (15 steps PASS); LiteSVM suite; ADR-0005 | The program is Anchor, not Pinocchio. Not frozen: there is no audit (L2) and the upgrade authority is not yet a multisig (H13). One program id plus `migrate_protocol`, not versioned ids. There is no allocation-root instruction (a claim computes its fill from the clearing summary) and no close instruction (the call closes by time) |
| B1, VM1, VM6 uniform-price call auction | PARTIAL | Uniform price, pro-rata at the margin, limit orders, issuer supply schedule; ADR-0003 settles VM6 (lowest clearing price); `D5-conformance.md` | The price grid is chosen by the issuer, up to 256 ticks; the 0.5x reserve and 1% tick rules are not enforced. The sniper figures (about 0.03% against about 10%) come from a model that is not in the repository: NOT VERIFIED |
| Y1 recurring cross | PARTIAL | `CrossKind::Recurring` (a fee tier), escrow mode, keeper | No recurrence scheduler; no buyback, exit or liquidation flows |
| W7 two-sided double auction | PARTIAL | Sell orders from escrow, API, web | No AMM inventory, registered market makers, rebate pool or mint/redeem capacity beyond the issuer schedule |
| Z7 solver and market-maker sealed liquidity | NOT BUILT | `examples/venue` is a CPI example only | Later roadmap |
| W8 print guards | PARTIAL | Minimum volume, maximum imbalance, oracle divergence and staleness; refunds on no print; `oracle.test.ts` (6 cases) | No VRF extension, no halt or corporate-action flag, no lender feed |
| B14, B11, VM3 hard-to-game ending | NOT BUILT | Explicit tie-breakers only | No random end, coarse buckets, cancel cutoff or re-sign threshold |
| B2, H1, VM2, X4, Y4, Z5 private orders | PARTIAL | Commit-reveal with full escrow, per-cross `disclosure`, backup and restore in the web app; `C2` sealed flow; `W3` | No Arcium path (DP9 not run, H17), no threshold ciphertext, no keeper-decrypted default reveal. An unrevealed order is excluded and refunded in full |
| V-E, B6 full escrow at bid time | BUILT | Program, clients, tests | None |
| VM5, F1 verifiable clearing | PARTIAL | `clearing-core`, verifier CLI, `fairness-proof/v1`, `/v1/crosses/:address/proof`; `D5-verifier-devnet-sweep.md` (48 accounts, 38 verified, 0 mismatched, 10 not yet cleared) | No MPC or zero-knowledge proof: the receipt is the recompute JSON |
| B5 minimum raise, automatic refunds | PARTIAL | `min_matched`; refunds on no print | The issuer does not choose an accepted amount. Refunds need a permissionless claim, they are not pushed |
| VM7 issuer neutrality | NOT BUILT | none | No insider exclusion or bond |
| B8, VM10, S8 per-identity allocation | PARTIAL | Identity-gated entry through `cross_gate` (`C5-gate-sas-devnet.md`, 22 steps PASS) | No per-identity cap, one-ID-one-application rule, lottery tier or identity-bound vesting. The decision log in `CLAUDE.md` mentions a capped lottery tier; none exists |
| B9, T3 allocation policies | NOT BUILT | Pro-rata only | |
| B10 snapshot hygiene | NOT BUILT | none | OS |
| B12 anti-flip | PARTIAL | `cross_gate` locks that can only be tightened (`DP-dbc-hook.md`) | No buyer-lockup option, no flipper priority; DBC strips the hook at graduation |
| B13 float and FDV guardrails | NOT BUILT | none | |
| W11 halt-resume triggers | NOT BUILT | `token-safety` detects a paused mint | No trigger logic |
| W5 `cross_calendar` | BUILT (program, client, tests) | `C6-calendar-devnet.md` (22 steps PASS); `calendar.test.ts` | No indexer, API, UI or keeper support. Permissionless apply after the 7-day lock is covered on LiteSVM only. The keeper has no calendar logic |
| W12, B3 continuous-clearing mode | NOT BUILT | none | OS |
| V4 tender crosses | NOT BUILT | `CrossKind::Tender` is a fee label | Needs counsel (H2) and a placement partner |
| V7 unlock and block-sale crosses | PARTIAL | Generic escrow-mode crosses | No lockup or collateral integration |

## 5. Settlement adapters and Meteora lifecycle

| ID | Status | What exists | Gap |
|---|---|---|---|
| W2, V-E `cross_settle` adapters | PARTIAL | `open_dbc_pool` plus `bind_dbc_mint`, `seed_damm_v2`, `open_dlmm_pair`, `seed_raydium_cpmm`; clients, `packages/adapters`; devnet A1 to A4 (`A1-dbc-continuation-devnet.md`, `A2-damm-v2-devnet.md`, `A3-dlmm-devnet.md`, `A4-raydium-cpmm-devnet.md`) | `none` is core `finalize` (C2). `external_cpi` is the `examples/venue` program, run on LiteSVM only, not an instruction of `cross_settle`. The timelock rule is not enforced by the program |
| X3 MetaDAO adapter | NOT BUILT | none | |
| X13, R2, V-D Meteora full lifecycle | PARTIAL | DBC, DAMM v2 and DLMM adapters; Presale Vault proved on devnet (`DP11-presale-vault.md`); volatility-aware fee parameters (`DP-volatility-fee.md`) | Alpha Vault, Met Lock, Dynamic Fee Sharing and Zap are not built; the Presale Vault is proved but not integrated |
| D3, V-D design (d) | PARTIAL, wording differs | Start price exactly P*, transfer hook installed, mint authority handed to the cross, optional dynamic fee; `A1` 18 steps PASS | Two resumable steps, not one transaction. Mint authority is revoked at `finalize`, not in the same transaction as allocation. The curve is issuer-chosen (`sqrtPriceMultiples`), not demand-calibrated segments. Migration uses `MET_DAMM_V2` with a fixed fee, not Compounding, and no vesting. No proceeds routing to treasury, locked liquidity or greenshoe. Not verified on devnet: migration of an adapter-opened pool, an allowlist-mode gate on it, more than one winning bidder |
| D2 post-cross depth | PARTIAL | DBC curve above P* | No DLMM conviction or limit-order pools |
| D1, X17 DAMM v2 Compounding graduation | PARTIAL | Full-range pool at exactly P* (`A2`); permanent liquidity lock, vesting schedule and compounding fee mode through Meteora's own instructions, proven on the real cp-amm binary in LiteSVM (`D1-damm-lock-compounding.md`, ADR-0022) and on devnet, 22 steps PASS, with Meteora's own refusals read from the logs (`D1-damm-lock-compounding-devnet.md`) | No market-cap scheduler or reward slots |
| D10, Z0 graduation by holder vote | NOT BUILT | none | No governance program (ADR-0013 covers admin only) |
| D4, VM8, X18 greenshoe | NOT BUILT | none | |
| D5 DLMM conviction pool | PARTIAL | `open_dlmm_pair` opens the pair at P*; `buildDlmmConvictionLadder` commits unsold base tokens as one-sided depth above P* through Meteora's own instructions, proven on the real lb_clmm binary in LiteSVM (`D5-dlmm-conviction-ladder.md`, ADR-0023) and on devnet with two real buys (`D5-dlmm-conviction-ladder-devnet.md`) | Only the `taper` shape was swapped through; limit-order variant not built |
| F4, VM4, B15 batch-opened graduation | NOT BUILT | none | |
| W10 pool pause and rebalance | NOT BUILT | none | |
| X12, C1 stock-quoted pools | PARTIAL | Adapters accept any quote mint; mint properties read (`DP14.md`) | No badge check, no stock quote mint run on devnet, no Alpha Vault entry (Token Badge: H9) |
| X14, R1 Meteora volume engine | NOT BUILT | none | |
| D7 fee sharing routing | PARTIAL | Meteora Dynamic Fee Sharing vault: create (1 to 5 recipients), fund, claim, and the DAMM v2 bridge (the position goes to the vault, its trading fees are pulled in and split), proven on the real program binaries in LiteSVM (`D7-fee-sharing-vault.md`, ADR-0024) and on devnet end to end, from a real swap to both claims (`D7-fee-sharing-vault-devnet.md`) | The DBC fee bridges are not built |
| R4 multi-asset pairing | NOT BUILT | none | |
| B4 Presale Vault fixed-price mode | PARTIAL | Devnet proof only | Not integrated into a cross or the app |
| D6, D8, D9, R3 | NOT BUILT | none | OS or later |

## 6. Ownership-coin template and treasury

| ID | Status | What exists | Gap |
|---|---|---|---|
| X2, A5 template | PARTIAL | `treasury` program, client; allowance, SAS-gated release, lapse and grace, liquidation snapshot, exact pro-rata redemption; `A5-treasury-devnet.md` (26 steps PASS), `treasury.test.ts` | No indexer, API or UI; no rights-card library; no milestone team tokens |
| Z2 recurring crosses for existing coins | PARTIAL | Escrow mode takes any mint | No templates; hooked-mint escrow is deferred (ADR-0005) |
| V3, Y6 verified-revenue tranches | PARTIAL | SAS attestation parsing in the treasury | No payment-processor attester, no distributions |
| E1, E2 holder-governed treasury | PARTIAL | Allowance | Votes above the allowance are not in this version (ADR-0014) |
| E3, VM8 NAV floor and redemption | PARTIAL | Lapse-triggered pro-rata redemption | No bid wall, vote or TWAP bids |
| E7 wind-down | PARTIAL | Liquidation plus redeem | No withdraw-only window or runbook |
| E4, E5, E6, E8, A6, K4 | NOT BUILT | none | E6 needs counsel; K4 is OS |
| V6, R8 flagship real-company IPO | NOT BUILT | none | H1, H2, H8, L5, L6 |

## 7. Stocks: reopen, halt and unlock crosses

| ID | Status | What exists | Gap |
|---|---|---|---|
| X1, V2, C2 weekly reopen and unlock crosses | PARTIAL | `Reopen` kind, calendar program, a sealed escrow reopen on devnet (`C2`, `C6`) | Nothing on mainnet; no weekly generator; no unlock logic; no lender feed. DP10 found a uniform-price call auction for xStocks already exists (Uncross) |
| C1, VM9, C3 listing cross with an oracle median | PARTIAL | One pinned Pyth feed guard (program, SDK, LiteSVM; `DP15-pyth-mainnet.md`) | No median, no second oracle, no off-hours band widening. The pull update proof (`DP15-pyth-pull-devnet.md`) failed with a 401 and has not been re-run |
| Y5, Z5 stock-token safeguards | PARTIAL | `packages/token-safety` (library), `DP14.md` | Detection only: not called by cross creation, the keeper or the API, not shown in the UI |
| Z3, C5, C6, S9 | NOT BUILT, except S9 PARTIAL | S9: cross-page countdown | No pegged-to-open orders, corporate actions or composite reference price |

## 8. Router and execution quality

| ID | Status | What exists | Gap |
|---|---|---|---|
| Z1 open-execution router | PARTIAL | `packages/router`: a cross quote against a live Jupiter route at the same moment (`D6-router.md`) | No API route or UI use; no weekend pools, no execution |
| Y2 execution-quality metric | BUILT | `GET /v1/metrics/execution` over every Finalized cross that printed: fill rate, price improvement of each filled bid against its own limit (median, 10th percentile, in bps and quote atoms), refund share, close-to-cleared and close-to-finalized times, each with its sample size and a method line; shown on `/accuracy` and the home page. Open-order limit prices are recovered from the `commit_order` instruction data by the indexer (`services/indexer/src/order-terms.ts`); bids whose terms are not yet recovered are reported as `unaccounted`, never guessed. Figures recomputed independently from the live API and equal (24 of 24) | Bids only, not asks; the sample is our own devnet test traffic and the page says so |
| X8, C4, K5 | NOT BUILT | none | |

## 9. Liquidity

| ID | Status | What exists | Gap |
|---|---|---|---|
| W9 order entry paths | PARTIAL | Direct `place_order` (program, API, web, mobile, SDK); CPI venue example | No pool resting liquidity, aggregator intents or signed market-maker quotes |
| X6, Y7, P6 | PARTIAL | Jupiter quote; `@opening-cross/x402`: pay-per-call for HTTP and MCP (x402 exact scheme and the MPP charge intent, a self-hosted facilitator, a paying client, a Postgres payment ledger), 51 unit tests pass | The 54 integration tests that need Postgres and a validator were skipped here and have not been run; not wired into the API or MCP server; no Blinks or market-maker bot |

## 10. Integrity, data and AI

| ID | Status | What exists | Gap |
|---|---|---|---|
| F1 fairness report | BUILT | `GET /v1/metrics/fairness`: per cross and in aggregate, distinct bidding wallets, the share of filled volume taken by the largest 1, 5 and 10 wallets, a Wilson interval over crosses for the share where the top buyer exceeds a threshold, and a method line; additive `fairness` field on a finalized cross | The identity count is wallets, not people (no gate on most crosses); top-5 and top-10 shares read no data because crosses have at most 3 bidders |
| F7 impersonation protection | PARTIAL | `packages/authenticity` (1,774 issuer-listed mints), `/v1/tokens/:mint/authenticity`, cross-page panel, issuer-console check; ADR-0016, `T-trust-e2e.md` | Mainnet and listed issuers only; no duplicate-ticker warning for arbitrary tokens; republication of the lists awaits H15 |
| S12 launch replay | PARTIAL | Per-cross events, orders, book, proof | No 30-day view |
| S2, F2, F3, F5, F6, F8, F9, V5, X10, J3 | NOT BUILT | none | The signed-promise track record (`/accuracy`) is a different thing from V5 |
| V-A release bars | PARTIAL | Clearing reproducibility holds (525 vectors, 38 devnet crosses) | The bot, OVS, AI, agent and simulator bars cannot be measured: the features do not exist |

## 11. Compliance and identity

| ID | Status | What exists | Gap |
|---|---|---|---|
| W3, B7, G7, G8 `cross_gate` | BUILT | SAS, Merkle allowlist and open gates; `claim_pass`, `claim_pass_merkle`; `C5-gate-sas-devnet.md` (22 steps PASS), `sas.test.ts`; identity enforced by the DBC hook during the curve (`DP-dbc-hook.md`) | No web or API path to claim a pass; the issuer console has no gate field (the API accepts `gateMint`); Merkle on devnet and a real issuer (H2) not covered. The Ed25519 permit fallback is not built |
| G2, V6 resale locks | PARTIAL | `set_lock`; `DP8-token-acl.md` (11/11 on mints we create) | No Reg S or CF presets; Token ACL does not work for DBC-created mints (ADR-0004); H9 |
| G4, G5 | PARTIAL | A SAS credential per cross; allowlist, SAS and lockups | No accredited-investor flow; no country, holder-cap or blackout rules |
| G1, G3, G6, A4, A7, R14, T4 | NOT BUILT | none | Counsel and partners (H1, H2) |

## 12. Privacy

H2 confidential balances and H3 private treasury operations: NOT BUILT. Sealed orders are commit-reveal (section 4).

## 13. Opening Bell app and UX

| ID | Status | What exists | Gap |
|---|---|---|---|
| X7, M9 mobile app | PARTIAL | `apps/mobile` (Expo, Mobile Wallet Adapter), ADR-0020: strict typecheck, 26 tests, Android export | Not run on a device (H19); no onramp or embedded wallet |
| Y9, M6 holdings and portfolio | PARTIAL | `/orders` page and the cross-page "Your orders"; mobile Orders screen | No positions, rights, votes, distributions or P&L |
| Z6, M5 post-trade | PARTIAL | Fill report, claim and refund buttons | No notifications, onramp or claim center |
| T2 calendar | PARTIAL | `/calendar` groups crosses by their real windows (open now, opening soon, closed) by local day with UTC beside each, and an Add to calendar control downloads a valid RFC 5545 file; `cross_calendar` | No waitlists or reminders; the add-to-calendar download was tested against a local mock because the live site has no open or upcoming cross |
| M1 discovery | BUILT | `/crosses` filters by state, bid disclosure and supply mode, free-text search on address or mint, four sorts, state in the URL, empty state, live result count (counts equal the API for every case tried) | Disclosure and supply-mode filters read each cross's detail lazily (about 60 to 90 s for 57 crosses the first time); adding the two fields to the list endpoint would remove that |
| M2, S3 asset page | BUILT | Three-number hero (live: indicative price, offered versus wanted, countdown; settled: price, matched, fills), Token Facts card with mints, decimals, supply mode, fees, gate, oracle guard, creator and the authenticity verdict, and keyboard-navigable Overview, Book, Orders and Proof tabs with deep links | Verified on real priced, no-print, sealed and gated crosses; the Live phases were exercised with the real detail and a rewritten state because no cross was open |
| M3 timeline | BUILT | Four-stage timeline from the real window times with the current stage marked, and a worked example computed from the cross's own clearing (matches the indexer's order record); a no-print cross says why | The API serves no timestamps for Cleared and Finalized, and the page says so |
| M4 request, preview, confirm | BUILT | Before signing: escrow, best and worst case, share of the offered supply and price impact against the indicative price, from a TypeScript port of the clearing rule tested against the verifier's reference on 400 random books; sealed crosses show only escrow and share | The impact is shown only when it reproduces the API's own indicative price |
| S1 price-discovery view | PARTIAL | Book chart, WebSocket updates, indicative price, and a marker with legend for the connected wallet's own orders (never drawn for unrevealed sealed orders) | No coarse final window; an order's limit price is only known for orders placed in this browser (the API does not serve it for open orders), others are listed as not placeable |
| M10, M11 consumer standard | PARTIAL | Light and dark, 42 contrast pairs at AA, axe clean on every route (`W1-W2-web-landing.md`) | Addresses and mint names are visible; no risk-acknowledgment screen. Axe covers WCAG 2.1 AA, the target says 2.2 |
| I1 to I3, I8 | PARTIAL | Browse without a wallet; Wallet Standard connect; non-custodial escrow, free cancel | No KYC step, embedded wallet or readiness checklist |
| T1, M7, I4 to I6, S14, S11, S10, S4, S7, S5, M8, M12, I7, R6, N1, N2 | NOT BUILT | none | |
| UX targets [V-U] | NOT MEASURED | Contrast AA and Lighthouse (`W1-W2-web-landing.md`: mobile 97, desktop 100 performance) | Time to first bid, task success, SUS and the other bars are not measured |

## 14. Issuer tools

| ID | Status | What exists | Gap |
|---|---|---|---|
| A1 listing types | PARTIAL | Kinds launch, reopen, tender, recurring; treasury for revenue share | No stock listing flow through tokenizers |
| A9, T6, T5 wizard | PARTIAL | `/issue` form with on-chain checks (`W4`, 11 checks) | No presets, auto-fill or concierge |
| A2, A3, S13, A8, A10, R5, R7 | NOT BUILT | none | |

## 15. Standard, SDK and integrations

| ID | Status | What exists | Gap |
|---|---|---|---|
| W13, V1 verifier and conformance | BUILT | `packages/verifier`, 525 vectors checked in CI, `D5-conformance.md` | Not on a registry (H12); the proof schema is a TypeScript type and a string |
| W13, V1 OCIP spec and sRFC | NOT BUILT | none | Needs an authored specification |
| W14, L3 SDK and UI kit | PARTIAL | `@opening-cross/sdk`, `opening-cross-cpi`, `examples/ts-quickstart` (run in CI), `D4-sdk-and-cpi.md`; `@opening-cross/client` (typed API client, exact unit maths, order validation, signing pipeline; 17 tests), `@opening-cross/react` (hooks and components; 34 tests) and `@opening-cross/cli` (read, place, cancel, reveal, claim, settle, verify; 20 tests) | None of the three has been run against a live cluster or published to a registry (H12); the cross-language parity test against a Rust SDK was dropped because that crate is not in the repository |
| W15 reference integrations | PARTIAL | Design (d), router comparison, `examples/venue` | No reopen, halt, tender or block-sale adapters; the Genesis composition is not run on devnet |
| L4, X16 data and agents | PARTIAL | `/v1/stream`, `services/mcp` (12 reads, 5 drafts, 9 tests; ADR-0019) | No gRPC stream, backtester or agent skill file |
| L7, J4 docs for humans and AI | PARTIAL | MCP server; `/developers`; `docs/CONFIGURATION.md`; `/llms.txt` and `/llms-full.txt`, with a test that every documented route exists in the server and every server route is documented | No docs MCP |
| L2, X15, L5, J1, J5, L1 | NOT BUILT | none | |

## 16. Business model

| ID | Status | What exists | Gap |
|---|---|---|---|
| W4, W6 fees | PARTIAL | Fees live in `cross_core` (ADR-0010): the protocol fee is the smaller of the schedule and a quarter of the integrator fee, snapshotted per cross, charged to the sell side, never on bids, cancels or refunds; schedule 30, 5, 15 and 30 bps | There is no separate `cross_fees` program. The figures are proposed; `docs/economics/FEE_MODEL.md` and `packages/fees` (fee schedule, fee model, revenue ledger, scorecard, referral shares, rate cards and signed statements; 57 tests) model them in exact arithmetic off chain. The 10% referrer share exists in that accounting only, not in the program |
| Z4, Y7 external-flow scorecard | PARTIAL | `GET /v1/metrics/external-flow` excludes each cross's creator, integrator, proceeds and fee recipient and a configurable `OWN_WALLETS` list, and reports external against own wallets with the sample size; verdict worded as an upper bound on outside users | `OWN_WALLETS` is not yet passed through `deploy/docker-compose.yml`, so production uses the per-cross exclusions only; no market-maker flow exists to exclude |
| Y8, X11, P1, P2, P3 to P5 | NOT BUILT | none | |

## 17. Engineering architecture and quality bars

| ID | Status | What exists | Gap |
|---|---|---|---|
| V-E programs and architecture | PARTIAL | Five programs; sharded books (32 shards, 256 ticks); integer maths; keepers (`D2-keeper-devnet.md`); finalized-only indexer with a reconciler | Fees are inside `cross_core`; no Yellowstone source (H7); no WASM preview or Python simulator |
| Q1 open source | PARTIAL | Apache-2.0 (ADR-0002); Meteora called through deployed programs | The repository is private (H21) |
| Q2 testing | PARTIAL | LiteSVM suites, property tests (10,000 cases), randomized end-to-end runs | No Mollusk, Surfpool or cargo-fuzz; no adversarial simulator |
| Q3 audits, builds | PARTIAL | Verifiable build; all five programs match on devnet (`L4-verifiable-build.md`) | No audit (H6), bug bounty or monitoring with auto-pause |
| Q5 disclosure of third-party powers | BUILT | `/status` section "Who holds power" reads the upgrade authority of each deployed program and the protocol admin, guardian and fee recipient live from devnet, and states what each external program (Meteora, Pyth, Jupiter, Token-2022) can do to a cross; it says plainly that one key can upgrade all five programs today | Reads the public devnet RPC, which can answer 429 under heavy shared use (retried) |
| X19 devnet proofs | PARTIAL | DP1 to DP6, DP8, DP10 to DP12, DP14 done | DP7, DP9, DP13 (latency target) and DP15 (pull proof) open |
| Q4, R10, R11, R12, R15, O2, O3 | NOT BUILT | none | |
| O1 public dashboard | PARTIAL | `/status`, `/accuracy`, landing totals | Devnet figures only |

**Performance targets** (`DP13-scale.md`, `DP13-devnet-latency.md`)

- Bid at most 25k CU: measured, 21,633 CU at 100,000 orders. Met.
- 100,000-order settlement: 33 transactions and 783,740 CU. This is compute, not wall-clock time; the 10-minute figure is not measured on a network.
- Landing latency on public devnet: p50 2.6 s, p90 17.7 s against a 5 s p90 target. **Not met**; not verified on a paid RPC (H7).
- 1,000 bids per second and 1M bids per auction: not measured.

**Invariants.** `docs/security/INVARIANTS.md` lists 13, each with its enforcement and tests; the 11-item list in `PRODUCT_FEATURES.md` section 17 is the earlier planning list. They are tested by property tests and randomized runs; there is no formal proof. "One ID one application" is not enforced (the gate is one pass per wallet). The pool-seeding invariant is exact for DBC and DAMM v2, within one atom for Raydium and within half a bin step for DLMM.

## 18. OS and long-term

K2 PARTIAL: `packages/risk` is a working weekend risk engine (gap statistics, gap-aware maximum LTV with a distribution-free guarantee, fair value with confidence bands, band-tied liquidation decisions), 29 tests pass and a 10-year walk-forward over 15 US stocks is in `docs/evidence/K2-risk-engine.md` (ADR-0210); it is a library, not a lending market, and tokenized stocks' own weekend prices were not measured against it. K1 and R9: NOT BUILT. The premium monitor is not a risk engine.
