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
| D1, X17 DAMM v2 Compounding graduation | PARTIAL | Full-range pool at exactly P* (`A2`); permanent liquidity lock and compounding fee mode through Meteora's own instructions, proven on the real cp-amm binary in LiteSVM (`D1-damm-lock-compounding.md`, ADR-0022) | Not run on devnet (no SOL); no market-cap scheduler or reward slots; partial locks and vesting not built |
| D10, Z0 graduation by holder vote | NOT BUILT | none | No governance program (ADR-0013 covers admin only) |
| D4, VM8, X18 greenshoe | NOT BUILT | none | |
| D5 DLMM conviction pool | PARTIAL | `open_dlmm_pair` opens the pair at P*; `buildDlmmConvictionLadder` commits unsold base tokens as one-sided depth above P* through Meteora's own instructions, proven on the real lb_clmm binary in LiteSVM (`D5-dlmm-conviction-ladder.md`, ADR-0023) | Not run on devnet (no SOL); only the `taper` shape was swapped through; limit-order variant not built |
| F4, VM4, B15 batch-opened graduation | NOT BUILT | none | |
| W10 pool pause and rebalance | NOT BUILT | none | |
| X12, C1 stock-quoted pools | PARTIAL | Adapters accept any quote mint; mint properties read (`DP14.md`) | No badge check, no stock quote mint run on devnet, no Alpha Vault entry (Token Badge: H9) |
| X14, R1 Meteora volume engine | NOT BUILT | none | |
| D7 fee sharing routing | NOT BUILT | none | |
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
| Y2 execution-quality metric | PARTIAL | The best-execution report schema | No aggregate metric |
| X8, C4, K5 | NOT BUILT | none | |

## 9. Liquidity

| ID | Status | What exists | Gap |
|---|---|---|---|
| W9 order entry paths | PARTIAL | Direct `place_order` (program, API, web, mobile, SDK); CPI venue example | No pool resting liquidity, aggregator intents or signed market-maker quotes |
| X6, Y7, P6 | NOT BUILT | Jupiter quote only | No Blinks, x402, market-maker bot or revenue meter |

## 10. Integrity, data and AI

| ID | Status | What exists | Gap |
|---|---|---|---|
| F1 fairness report | PARTIAL | The proof carries price, matched volume, rationed side and the book | No cluster share with a confidence interval, identity count or method line |
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
| T2 calendar | PARTIAL | "Opens soon" state; `cross_calendar` | No calendar view, waitlists or reminders |
| M1 discovery | PARTIAL | `/crosses` newest first | No filters |
| M2, S3 asset page | PARTIAL | Price, book, signed band, identity panel, proof | No three-number hero, Token Facts card or tabs |
| M3 timeline | PARTIAL | Phases, countdown, UTC close | No four-stage timeline or worked example |
| M4 request, preview, confirm | PARTIAL | Escrow preview and grid validation | No best and worst fill, ownership share or price impact |
| S1 price-discovery view | PARTIAL | Book chart, WebSocket updates, indicative price | No coarse final window; no marker for the user's bid |
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
| W14, L3 SDK and UI kit | PARTIAL | `@opening-cross/sdk`, `opening-cross-cpi`, `examples/ts-quickstart` (run in CI), `D4-sdk-and-cpi.md` | No `@opening-cross/react`; no CLI beyond the verifier |
| W15 reference integrations | PARTIAL | Design (d), router comparison, `examples/venue` | No reopen, halt, tender or block-sale adapters; the Genesis composition is not run on devnet |
| L4, X16 data and agents | PARTIAL | `/v1/stream`, `services/mcp` (12 reads, 5 drafts, 9 tests; ADR-0019) | No gRPC stream, backtester or agent skill file |
| L7, J4 docs for humans and AI | PARTIAL | MCP server; `/developers`; `docs/CONFIGURATION.md` | No llms.txt or docs MCP |
| L2, X15, L5, J1, J5, L1 | NOT BUILT | none | |

## 16. Business model

| ID | Status | What exists | Gap |
|---|---|---|---|
| W4, W6 fees | PARTIAL | Fees live in `cross_core` (ADR-0010): the protocol fee is the smaller of the schedule and a quarter of the integrator fee, snapshotted per cross, charged to the sell side, never on bids, cancels or refunds; schedule 30, 5, 15 and 30 bps | There is no separate `cross_fees` program. The 10% referrer share is not built. The figures are proposed and have not been modelled |
| Z4, Y7 external-flow scorecard | PARTIAL | `/v1/stats` | Counts all wallets; no exclusion of team or market-maker flow |
| Y8, X11, P1, P2, P3 to P5 | NOT BUILT | none | |

## 17. Engineering architecture and quality bars

| ID | Status | What exists | Gap |
|---|---|---|---|
| V-E programs and architecture | PARTIAL | Five programs; sharded books (32 shards, 256 ticks); integer maths; keepers (`D2-keeper-devnet.md`); finalized-only indexer with a reconciler | Fees are inside `cross_core`; no Yellowstone source (H7); no WASM preview or Python simulator |
| Q1 open source | PARTIAL | Apache-2.0 (ADR-0002); Meteora called through deployed programs | The repository is private (H21) |
| Q2 testing | PARTIAL | LiteSVM suites, property tests (10,000 cases), randomized end-to-end runs | No Mollusk, Surfpool or cargo-fuzz; no adversarial simulator |
| Q3 audits, builds | PARTIAL | Verifiable build; all five programs match on devnet (`L4-verifiable-build.md`) | No audit (H6), bug bounty or monitoring with auto-pause |
| Q5 disclosure of third-party powers | PARTIAL | `token-safety`, `DP14.md` | Not shown in the UI |
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

K1, K2, R9: NOT BUILT. The premium monitor is not a risk engine.
