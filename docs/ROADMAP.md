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
| DP3 | Design (d) settlement atomic or safely resumable | Clear → config → mint → revoke within CU/account limits, or a locked resumable sequence | Measure CU and accounts per step on devnet | TODO | |
| DP4 | Mint authority = None after allocation | `getMint` shows no authority after settlement | Read mint after DP3 run | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP5 | Transfer hook invoked on every DBC swap path | Ineligible wallet's swap fails, eligible passes | Two wallets, both swap directions | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP6 | Migration with hook-locked balances | DBC → DAMM v2 migration succeeds with locked holders | Devnet migration run | DONE | [`docs/evidence/DP-dbc-hook.md`](evidence/DP-dbc-hook.md) |
| DP7 | Wallets and aggregators handle hooked mints | Phantom/Backpack display; Jupiter routing recorded | Manual wallet check + Jupiter API query | TODO | |
| DP8 | Token ACL gating after graduation | Blocked wallet fails, allowed wallet passes | Devnet Token ACL mint + two wallets | DONE | [`DP8-token-acl.md`](evidence/DP8-token-acl.md) 11/11 PASS on mints we create; NO-GO for DBC-created mints (no freeze authority / DAS) — handled by ADR-0004 |
| DP9 | Arcium 1k-bid benchmark | Cost/bid, latency, failure rate recorded; only aggregate revealed | Devnet MXE run with 1,000 bids | TODO | |
| DP10 | Reopen-cross novelty evidence | Documented search of Jupiter, Ondo, Kraken, xStocks, Backpack | Sources cited with dates | TODO | |
| DP11 | Presale vault partner-mint path | Base supply minted by partner authority before revoke | Devnet run | TODO | |
| DP12 | Genesis third-party bucket | Callable from our program or NO-GO | Read Genesis source + devnet call | TODO | |
| DP13 | Performance targets | bid ≤ 25k CU; throughput, landing latency, 100k-bid settlement measured | LiteSVM CU + devnet load test | TODO | |
| DP14 | Stock-token safeguards | Pause, permanent delegate, scaled-UI multiplier detected per mint on mainnet | Mainnet RPC reads of xStocks/Backpack mints | DONE | [`docs/evidence/DP14.md`](evidence/DP14.md); `packages/token-safety` 11/11 tests |
| DP15 | Oracle feeds for the price band | Pyth feeds read for target stocks; divergence guard triggers | Mainnet/devnet reads + unit test | TODO | |

## M2 — Core protocol

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| C1 | `clearing-core` crate: uniform-price clearing, pro-rata, tie-breaks, integer maths | Deterministic; matches an independent reference on 10k random books | Unit, property and differential tests | DONE | `crates/clearing-core`; ADR-0003; 13 tests incl. 10,000-case match against an exhaustive reference, conservation, order independence, vault solvency (`cargo test -p clearing-core --release`) |
| C2 | `cross_core` program: escrow, create, place/cancel, commit-reveal, close, sharded clear, allocation root, claim, refund | All invariants in ENGINEERING_PRINCIPLES §3.2 hold under fuzzing | LiteSVM unit + invariant + adversarial suites; devnet end-to-end | TODO | |
| C3 | Print guards and no-print fallback | Thin, imbalanced or oracle-divergent crosses do not print; refunds succeed | Adversarial tests | TODO | |
| C4 | `cross_fees`: per-cross fee snapshot and split | No fee on bids/cancels/refunds; protocol ≤ 20%; integrator 0–300 bps | Unit + property tests | TODO | |
| C5 | `cross_gate`: SAS credential, allowlist-Merkle, open | Gated wallet blocked, credentialed wallet passes | Devnet with real SAS attestation | IN PROGRESS | `programs/cross_gate` deployed: passes + locks as hook and Token ACL gate (DP5, DP8 evidence); SAS-credential pass issuance and Merkle allowlist still to build |
| C6 | `cross_calendar`: UTC calendar, oracle-set registry, timelocked admin | Timelock enforced; crosses scheduled from calendar | Unit + devnet | TODO | |

## M3 — Settlement adapters

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| A1 | `meteora_dbc_continuation` (flagship) | Cross clears at P\*, Q\* allocated, DBC pool continues, migrates to DAMM v2 | Devnet end-to-end with real DBC program | TODO | |
| A2 | `damm_v2` adapter | Pool seeded at P\* | Devnet | TODO | |
| A3 | `dlmm` adapter | Bins seeded around P\* | Devnet | TODO | |
| A4 | `raydium_cpmm`, `external_cpi`, `none` adapters | Each settles a devnet cross | Devnet | TODO | |
| A5 | Treasury / ownership-coin template | Allowance, attestation-gated release, holder liquidation | Devnet + adversarial | TODO | |

## M4 — Data and integration layer

| ID | Item | Acceptance | Test plan | Status | Evidence |
|---|---|---|---|---|---|
| D1 | Indexer (Yellowstone gRPC or RPC fallback) + Postgres + reconciler | Rebuilds full state from chain; never trusts `processed` | Kill/restart and replay tests | TODO | |
| D2 | Keepers: close, clear, settle, refund, calendar triggers | Idempotent; permissionless | Chaos tests on devnet | TODO | |
| D3 | REST + WebSocket API, unsigned-transaction builder | Every user action available via API | Contract tests | TODO | |
| D4 | TypeScript SDK + Rust CPI crate (Codama clients) | Published packages build a full cross from a clean project | Example project in CI | TODO | |
| D5 | Independent verifier + fairness-proof schema + conformance suite | Verifier recomputes every devnet cross exactly | Run against all devnet crosses | TODO | |
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
