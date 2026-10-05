# Opening Bell — Engineering Principles

How we plan, build, test, design and ship for the next 12 months. Read before your first commit. When in doubt, the stricter rule wins.

## 0. Non-negotiables (these override everything below)
1. **Always the best option, always the best product.** When choosing between approaches, pick the one that gives the best result for users and the company. Never pick an option because it is faster, cheaper or easier to build.
2. **No compromise.** Never accept a lesser version of anything: design, code, tests, copy or docs. If something is not the best we can make, it is not finished.
3. **No time limit, no build limit.** Deadlines, sprint size, headcount and lines of code are never reasons to shrink scope or quality. If the best version needs more work, we do the work.
4. **Never guess.** Every fact comes from source code, official docs, the chain or a test we ran. If it cannot be checked, it is marked NOT VERIFIED and resolved before anything is built on it.
5. **Test exactly as it is meant to be used.** Every feature is tested the way a real user, a real integrator and a real attacker would use it, on every surface and in every state, with real transactions, and judged on the outcome, not on a status code. Untested means not done.
6. **Prove before claiming.** "Best", "done", "secure" and "works" each need evidence. Without evidence we write NOT VERIFIED.

## 1. Mindset
1. **We are building a company, not a demo.** Every line must be something we would run with real users' money on mainnet. Hackathons and deadlines are checkpoints, never reasons to cut scope or quality.
2. **Users' money first.** Funds safety outranks features, speed and looks. If a change touches escrow, settlement, fees or keys, it is the highest-risk work in the company.
3. **Truth over optimism.** Nothing is "done", "safe", "fast" or "verified" without evidence: a test, a transaction signature, a screenshot, a benchmark. If it isn't proven, write NOT VERIFIED.
4. **Best solution first.** Propose the right design, then the cheaper alternatives with their trade-offs. Never pre-shrink a plan because it looks big.
5. **Own the whole path.** A feature is done when data, program, indexer, API, UI and docs all work together, end to end, as a real user would use it.
6. **Disagree early, commit fully.** Argue before a decision with reasons; once decided (see CLAUDE.md Decisions log), execute it without quietly reinterpreting it.

## 2. Planning
1. Every feature starts from a written spec: problem, user, success metric, failure modes, which screen, which program, which adapter. Link it to PRODUCT_FEATURES / BUILD.md IDs.
2. Never guess a fact (API shape, SDK version, protocol behaviour, rule, price). Check the source code, official docs or chain. Cite it.
3. Unknown dependencies get a **devnet proof first** (BUILD.md §6) before any feature is built on top of them.
4. Every decision is logged once (CLAUDE.md Decisions log). No silent re-litigation in PRs.
5. Plan for adversaries: for every feature, write how a sniper, a bot, a malicious issuer, a frontrunner and a compromised key would attack it.

## 3. Building
1. **Programs:** minimal, auditable, frozen once audited. `cross_core` holds escrow and never CPIs into AMMs; adapters are separate and timelocked. Checked math only, no `unwrap` in program code, explicit account validation on every instruction.
2. **Invariants are code, not comments:** total escrow = sum of open orders; one clearing price per cross; refunds never fail; mint authority revoked after allocation; fees snapshot at cross creation; no fee on bids, cancels or refunds.
3. **No mock standing in for the real thing.** No hard-coded prices, fake fills, fake stats, fake issuers, fake audits. Example data is visibly labelled "Example".
4. **Pin every version** (Rust, Anchor, SDKs, npm) and record why. Upgrade deliberately, never by accident.
5. **One source of truth:** chain > indexer > API > UI. The UI never computes money on its own; it displays what the chain and indexer prove.
6. Small PRs, one concern each, reviewed by someone else. Program PRs need two reviewers.
7. Write code that reads like the surrounding code. No dead code, no TODOs left in main, no "temporary" hacks.
8. Never hand-type a program ID, mint or other well-known address. Import it from the official client package or derive it, and cover it with a test that hits the real account. (A mistyped SPL Token ID once broke Raydium settlement and silently rejected every classic SPL mint.)

## 4. Design
1. **Source of design:** Claude Design exports (`Opening Bell Landing.html`, `Opening Bell Mobile.html`) first, then Linear / Stripe patterns. Do not invent a new visual style.
2. Tokens only (colour, type, spacing, radius) — no one-off hex values in components.
3. WCAG AA everywhere (≥4.5:1 text, ≥3:1 UI). Light and dark themes. Keyboard and screen-reader usable. Works at 360 px and 1920 px.
4. Every money action shows: what you pay, max you can pay, fees, what happens if the cross fails, and how to get your refund. No dark patterns, no fake urgency.
5. Every screen has its empty, loading, error, partial-fill, refunded and failed-cross states designed — not just the happy path.
6. Copy is plain English, honest, and matches the actual mechanism (pro-rata, fees, privacy mode).

## 5. Testing & checking
1. Use the four honest states only: **PASS / FAIL / PENDING / BLOCKED.** BLOCKED means three serious attempts, written down.
2. Programs: unit tests, property/fuzz tests on clearing and allocation, invariant tests, and adversarial tests (sniping, griefing, dust, max orders, reentrancy, account substitution).
3. Every flow is tested as a real user on devnet: real wallet, real transactions, signature recorded, balance checked on chain.
4. Test every state, not the demo: unpaid, insufficient funds, cancelled, thin cross / no print, oracle stale, issuer pause, refund, wrong network, junk input.
5. Every surface: web desktop, mobile web, native app, SDK, API, Blinks. A green run on one surface proves nothing about the others.
6. Visual check: screenshot every page in light/dark, desktop/mobile, and actually look at it. Zero console errors is part of passing.
7. Recompute independently: clearing price and allocations are re-derived by the TypeScript verifier and must match the chain exactly.

## 6. Security & keys
1. Never commit secrets, keypairs, `.env`, seed phrases or personal files. `.keys/` and `.secrets/` are git-ignored; check `git status` before every commit.
2. Mainnet upgrade and treasury authority sit behind a multisig (Squads) with a timelock. No single person can move funds or upgrade programs.
3. External audit before any mainnet value; public bug bounty after.
4. Least privilege for every service key and RPC credential; rotate on any suspicion.

## 7. Resources & dependencies
1. Before relying on a protocol (Meteora DBC/DAMM v2/DLMM, Token ACL, SAS, Arcium, oracles, stock tokens), read its source and docs, and prove the exact behaviour on devnet.
2. Check licences before reusing any code from `research/repos/`.
3. Every external service (RPC, KYC, onramp, VRF, sanctions) has an owner, a fallback and a cost line in BUILD.md.

## 8. Shipping & operating
1. Devnet → private mainnet (team funds, capped) → public mainnet with caps → raise caps. Each stage gates on tests, audit status and monitoring.
2. Monitoring and alerts exist before launch: failed transactions, escrow mismatches, stuck refunds, oracle divergence, RPC errors.
3. Every incident gets a written post-mortem; every miss becomes a new test.
4. Metrics are honest: external users and external volume reported separately from team / market-maker activity.

## 9. Definition of done (every PR)
A PR is done only when every box is true; otherwise it is not merged.
- [ ] Spec linked; behaviour matches it, including failure and edge states.
- [ ] Tests added for the new behaviour and for the bug class it could introduce; CI green.
- [ ] Program changes: compute-unit cost measured and recorded, account sizes and rent checked, invariant tests pass, two reviewers.
- [ ] UI changes: screenshots in light/dark × desktop/mobile attached to the PR; zero console errors; keyboard path works.
- [ ] Docs, SDK types and changelog updated in the same PR.
- [ ] No secrets, no personal files, no unpinned dependency, no new licence risk.

## 10. Code, CI & supply chain
1. `main` is protected: no direct pushes, required reviews, required CI (build, lint, type-check, unit, program tests, `cargo audit` / `npm audit`, secret scan).
2. Lockfiles committed; new dependencies need a stated reason, a licence check and a maintainer-health check. Prefer fewer dependencies on money paths.
3. Builds are reproducible: programs are built with verifiable builds and the deployed hash is published and checked against the repo.
4. Every program upgrade ships with a migration plan, a rollback plan and a changelog entry; account layouts are versioned, never silently changed.

## 11. Architecture decisions & documentation
1. Any decision that is hard to reverse (account layout, fee model, privacy scheme, adapter interface, new vendor) gets a short ADR in `docs/adr/`: context, options considered, decision, consequences.
2. The open standard (OCIP), SDK and fairness-proof schema are versioned with semver; breaking changes need an ADR and a deprecation window.
3. Docs are written for a stranger: every published instruction is executed literally before release.

## 12. Legal, compliance & data
1. Anything touching securities, tokenized stocks, KYC, sanctions, user funds custody or cross-border money (including India ODI/FEMA) goes to the founder and counsel before it ships. Engineers do not decide legal questions.
2. Geo-blocking, sanctions screening and identity gating are built as real, tested features, not banners.
3. Collect the minimum personal data; never log wallet-to-identity links, KYC data or IPs beyond what is required; follow the retention policy.
4. Product copy never promises returns, guarantees prices or implies regulatory approval we do not have.

## 13. Performance & reliability
1. Budgets are set and enforced in CI: page LCP < 2.5 s on mid-range mobile, interaction < 200 ms, program instructions within published compute-unit limits with headroom.
2. Clearing and settlement must work under congestion: priority fees, retries with idempotency, and sharded/resumable clears are tested at maximum order counts.
3. No single point of failure in infrastructure: at least two RPC providers, indexer can rebuild from chain, alerts route to an on-call person.

## 14. AI-assisted work
1. AI tools are welcome; their output is held to exactly the same bar as human code. The author owns every line they merge.
2. Never accept AI-generated facts, API names, versions or audit claims without checking the source. Never paste secrets or user data into external AI tools.

## 15. Never do
- Never ship fabricated numbers, users, issuers, audits or testimonials.
- Never charge a fee on a bid, cancel or refund, or hold user funds without a guaranteed refund path.
- Never claim "secure", "audited", "first" or "best" without evidence.
- Never merge untested program code or skip review on money paths.
- Never use mainnet keys on a dev machine, share keys in chat, or keep authority on a single key.
- Never copy a real brand's logo or name into our UI.
- Never cut scope, tests or quality to hit a date.
- Never leave a known bug undocumented; fix it properly or log it with an owner.
- Never add AI/author attribution trailers to commits; write commit messages plainly.
