# Opening Cross — Part 1 Roadmap

The build backlog for Part 1. Derived from the internal build plan (build order §4, devnet proofs §6, open decisions §7, audit §8). Every item has acceptance criteria and a test plan; it is DONE only when the evidence column links to proof (transaction signatures, test output, screenshots). Items that only a person can complete are marked HUMAN and have an exact step in `HUMAN_TASKS.md`.

Status values: `TODO` · `IN PROGRESS` · `DONE` · `HUMAN` · `NO-GO` (a proof failed; the fallback is recorded and becomes its own item).

## M0 — Foundations

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| M0.1 | Repository, allowlist `.gitignore`, secret-scan commit guard, CI skeleton | Repo on GitHub; CI runs on every push; secrets and key files cannot be committed | Stage a fake token and a `.keys/` file; guard blocks both; CI run green | DONE | Repo `Pratiikpy/opening-cross`; guard blocked staged `.keys/k.json` and a `ghp_` token (exit 2); CI run 37282531078 green |
| M0.2 | Toolchain pinned from live sources (Rust, Agave, Anchor, Node, pnpm) | `rust-toolchain.toml`, `Anchor.toml`, `package.json` engines match ADR-0001 | Clean clone builds with only the documented commands | TODO | |
| M0.3 | Devnet operations key and funding | Devnet key outside the repo, funded | `solana balance` on devnet | DONE | `DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC`, 10 SOL (2026-10-05) |

## M1 — Devnet proofs (no feature is built on an unproven dependency)

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| DP1 | Partner mints outside the DBC vault during pre-bonding | PDA mint authority mints to winner accounts before the curve is live; DBC accounting unaffected | Devnet script: create config + pool, mint, read pool state before/after | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP2 | Extra supply on a fixed-supply DBC config | Q\* minted beyond curve supply; migration math intact | Same pool driven to migration on devnet | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP3 | Design (d) settlement atomic or safely resumable | Clear → config → mint → revoke within CU/account limits, or a locked resumable sequence | Measure CU and accounts per step on devnet | DONE | Resumable two-step settlement against the mainnet DBC binary in LiteSVM: `open_dbc_pool` 140,991 CU, `bind_dbc_mint` 63,690 CU (`tests/core/test/dbc.test.ts`); DBC pool's live `sqrt_price` equals P\* exactly |
| DP4 | Mint authority = None after allocation | `getMint` shows no authority after settlement | Read mint after DP3 run | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP5 | Transfer hook invoked on every DBC swap path | Ineligible wallet's swap fails, eligible passes | Two wallets, both swap directions | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP6 | Migration with hook-locked balances | DBC → DAMM v2 migration succeeds with locked holders | Devnet migration run | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP7 | Wallets and aggregators handle hooked mints | Phantom/Backpack display; Jupiter routing recorded | Manual wallet check + Jupiter API query | TODO | |
| DP8 | Token ACL gating after graduation | Blocked wallet fails, allowed wallet passes | Devnet Token ACL mint + two wallets | DONE | [`DP8-token-acl.md`](evidence/DP8-token-acl.md) 11/11 PASS on mints we create; NO-GO for DBC-created mints (no freeze authority / DAS) — handled by ADR-0004 |
| DP9 | Arcium 1k-bid benchmark | Cost/bid, latency, failure rate recorded; only aggregate revealed | Devnet MXE run with 1,000 bids | TODO | |
| DP10 | Reopen-cross novelty evidence | Documented search of Jupiter, Ondo, Kraken, xStocks, Backpack | Sources cited with dates | TODO | |
| DP11 | Presale vault partner-mint path | Base supply minted by partner authority before revoke | Devnet run | TODO | |
| DP12 | Genesis third-party bucket | Callable from our program or NO-GO | Read Genesis source + devnet call | TODO | |
| DP13 | Performance targets | bid ≤ 25k CU; throughput, landing latency, 100k-bid settlement measured | LiteSVM CU + devnet load test | IN PROGRESS | Bid ≤ 25k CU **PASS**: commit 20.3–21.1k, reveal 5.6k, merge 20.4k, clear (256 ticks) 11.3k, claim 27.7k (`tests/core/test/compute.test.ts`). Throughput, landing latency and 100k-bid settlement not yet measured |
| DP14 | Stock-token safeguards | Pause, permanent delegate, scaled-UI multiplier detected per mint on mainnet | Mainnet RPC reads of xStocks/Backpack mints | DONE | [`docs/evidence/DP14.md`](evidence/DP14.md); `packages/token-safety` 11/11 tests |
| DP15 | Oracle feeds for the price band | Pyth feeds read for target stocks; divergence guard triggers | Mainnet/devnet reads + unit test | IN PROGRESS | Guard built and tested (`tests/core/test/oracle.test.ts`: within band prints; divergence, stale, partial, foreign-owner, wrong-feed → no print; both Pyth receivers accepted). Mainnet reads [`DP15-pyth-mainnet.md`](evidence/DP15-pyth-mainnet.md): parser verified on live accounts; equity push accounts stale (24–40 days) or absent → pull model. Fresh pull post blocked on H11 (Pyth API key) |

## M2 — Core protocol

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| C1 | `clearing-core` crate: uniform-price clearing, pro-rata, tie-breaks, integer maths | Deterministic; matches an independent reference on 10k random books | Unit, property and differential tests | DONE | `crates/clearing-core`; ADR-0003; 13 tests incl. 10,000-case match against an exhaustive reference, conservation, order independence, vault solvency (`cargo test -p clearing-core --release`) |
| C2 | `cross_core` program: escrow, create, place/cancel, commit-reveal, close, sharded clear, allocation root, claim, refund | All invariants in ENGINEERING_PRINCIPLES §3.2 hold under fuzzing | LiteSVM unit + invariant + adversarial suites; devnet end-to-end | IN PROGRESS | `programs/cross_core` (ADR-0005); `tests/core`: 46 tests — flows, 15 attack cases, 25 randomized runs (200-run stress passed) vs independent reference with exact conservation. Devnet end-to-end pending |
| C3 | Print guards and no-print fallback | Thin, imbalanced or oracle-divergent crosses do not print; refunds succeed | Adversarial tests | DONE | Min-volume and imbalance guards both ways (`tests/core/test/flows.test.ts`); oracle guard 6 cases (`tests/core/test/oracle.test.ts`); 60/60 |
| C4 | `cross_fees`: per-cross fee snapshot and split | No fee on bids/cancels/refunds; protocol ≤ 20%; integrator 0–300 bps | Unit + property tests | DONE | ADR-0010 (fees live in `cross_core`); `tests/core/test/fees.test.ts`, `flows.test.ts`, creation caps in `adversarial.test.ts`; 71/71 |
| C5 | `cross_gate`: SAS credential, allowlist-Merkle, open | Gated wallet blocked, credentialed wallet passes | Devnet with real SAS attestation | IN PROGRESS | ADR-0012: SAS-attested and Merkle-allowlist self-service passes, permissionless revocation on expiry/closure; tested against the mainnet SAS binary with SAS-created attestations (`tests/core/test/sas.test.ts`, 79/79). Hook/Token ACL enforcement on devnet (DP5, DP8). Devnet SAS run pending H10 |
| C6 | `cross_calendar`: UTC calendar, oracle-set registry, timelocked admin | Timelock enforced; crosses scheduled from calendar | Unit + devnet | IN PROGRESS | ADR-0011; `programs/cross_calendar` + `cross_core` binding; `tests/core/test/calendar.test.ts` (75/75). Devnet run pending H10 |

## M3 — Settlement adapters

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| A1 | `meteora_dbc_continuation` (flagship) | Cross clears at P\*, Q\* allocated, DBC pool continues, migrates to DAMM v2 | Devnet end-to-end with real DBC program | IN PROGRESS | ADR-0006; `programs/cross_settle`, `packages/dbc-adapter`; local end-to-end against mainnet DBC binary passes (54/54). Devnet deploy blocked on H10 |
| A2 | `damm_v2` adapter | Pool seeded at P\* | Devnet | IN PROGRESS | ADR-0007; `cross_settle::seed_damm_v2` + `meteora-adapters` `buildSeedDammV2`; LiteSVM vs mainnet cp-amm: pool `sqrt_price` = P\* exactly, real swap 10 base → 11.94 quote vs 12.00 at P\* (`tests/core/test/damm.test.ts`). Devnet run pending H10 |
| A3 | `dlmm` adapter | Bins seeded around P\* | Devnet | IN PROGRESS | ADR-0008; `cross_settle::open_dlmm_pair` (active bin within half a step of P\*, exact on-chain pow); LiteSVM vs mainnet lb_clmm: bin 182 = 1.19951 for P\* 1.2, liquidity in 3 bins, real swap 10 → 11.983 vs 12.000 (`tests/core/test/dlmm.test.ts`). Devnet run pending H10 |
| A4 | `raydium_cpmm`, `external_cpi`, `none` adapters | Each settles a devnet cross | Devnet | IN PROGRESS | Raydium: ADR-0009, `cross_settle::seed_raydium_cpmm` (deposit ratio = P\* to one atom); LiteSVM vs mainnet raydium_cp_swap + mainnet AMM config/fee accounts: real swap 10 → 11.93 vs 12.00 (`tests/core/test/raydium.test.ts`). `none` = core finalize (tested). `external_cpi`: `examples/venue` routes a user order into cross_core with one CPI; settles to the user; venue cannot act without the user's signature (`tests/core/test/venue.test.ts`). Devnet pending H10 |
| A5 | Treasury / ownership-coin template | Allowance, attestation-gated release, holder liquidation | Devnet + adversarial | TODO | |

## M4 — Data and integration layer

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| D1 | Indexer (Yellowstone gRPC or RPC fallback) + Postgres + reconciler | Rebuilds full state from chain; never trusts `processed` | Kill/restart and replay tests | DONE | `services/indexer`; replay applies 0, reconcile zero drift on LiteSVM (85/85) and on live devnet history (9 events, 2 crosses) — `docs/evidence/D1-indexer.md`. Yellowstone source: HUMAN H7 |
| D2 | Keepers: close, clear, settle, refund, calendar triggers | Idempotent; permissionless | Chaos tests on devnet | IN PROGRESS | `services/keeper`: racing-keeper chaos test passes on LiteSVM (88/88); devnet pass ran and exposed the outdated devnet deployment — upgrade pending H10 (`docs/evidence/D2-keeper.md`) |
| D3 | REST + WebSocket API, unsigned-transaction builder | Every user action available via API | Contract tests | TODO | |
| D4 | TypeScript SDK + Rust CPI crate (Codama clients) | Published packages build a full cross from a clean project | Example project in CI | TODO | |
| D5 | Independent verifier + fairness-proof schema + conformance suite | Verifier recomputes every devnet cross exactly | Run against all devnet crosses | IN PROGRESS | `packages/verifier` (schema `opening-cross/fairness-proof/v1`, CLI `opening-cross-verify`): verifies all 25 randomized crosses and catches a tampered book (`tests/core/test/verifier.test.ts`, `properties.test.ts`, 80/80). Per-order allocation proofs need the indexer (D1); devnet run pending H10 |
| D6 | Router with best-execution reports | Report shows cross vs DEX route at the same moment | Live quote comparisons | TODO | |

## M5 — Opening Bell web app (from the Claude Design exports)

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| W1 | Design tokens (light + dark, WCAG AA) | All text ≥ 4.5:1, UI ≥ 3:1 | Automated contrast check | TODO | |
| W2 | Marketing landing (L0) with live or labelled-example data | Matches export; no fabricated proof | Screenshots ×4; Lighthouse; console clean | TODO | |
| W3 | Investor flow: connect, cross page, place/cancel bid, reveal, fill report, claim/refund | Real devnet transactions from the UI | Playwright with a real wallet, every state | TODO | |
| W4 | Issuer console: create and schedule a cross | Creates a real devnet cross | Playwright | TODO | |
| W5 | Developer portal and public status page | Docs executed literally by a fresh project | Stranger test | TODO | |

## M6 — Mobile

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| MO1 | Mobile web parity at 360–430 px | All W3 flows work on mobile web | Playwright mobile emulation | TODO | |
| MO2 | Native app (Expo) with Mobile Wallet Adapter | Place and claim on devnet from Android | Emulator run | TODO | |

## M7 — Mainnet staging, audit prep, launch, growth

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| L1 | Threat model, invariants doc, audit package | Auditor-ready repository | Internal review checklist | TODO | |
| L2 | External audit engagement and payment | Signed audit | — | HUMAN | HUMAN_TASKS H6 |
| L3 | Squads multisig + timelock for upgrade and treasury authority | No single key controls funds or upgrades | Devnet rehearsal | TODO | |
| L4 | Mainnet deployment with caps | Verifiable build hash matches repo | On-chain hash check | TODO | |
| L5 | Legal entity and counsel sign-off on asset classes | Written opinion | — | HUMAN | HUMAN_TASKS H1–H2 |
| L6 | First mainnet cross with external users | ≥ 1 cross, external wallets, public receipt | Indexer + verifier | TODO | |
| G1 | Hackathon and sidetrack submissions (Colosseum, Meteora, India) | Submitted before 2026-10-13 06:59 UTC | — | HUMAN | HUMAN_TASKS H3–H5 |
