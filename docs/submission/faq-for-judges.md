# Anticipated hard questions, with evidence-backed answers

For the 15-minute Colosseum interview, the Meteora and Superteam judges, and any reviewer. Each answer says what is proved, where, and what is not. If an answer here and the evidence file disagree, the evidence file wins; re-read the file before speaking. Figures are as of 2026-10-12.

## Status and honesty

**Is it audited?** No. There is no external audit. One is required before any mainnet value; engaging auditors is HUMAN_TASKS H6. What exists: `docs/security/THREAT_MODEL.md` (23 threats mapped to tests, open gaps named), `docs/security/INVARIANTS.md` (13 invariants with enforcement and tests), an audit package for reviewers (`docs/security/AUDIT_PACKAGE.md`), property tests and randomized end-to-end runs against an independent implementation. There is no formal proof.

**Is it on mainnet?** No. Everything runs on Solana devnet. The five programs are deployed on devnet and equal the local builds byte for byte (`docs/evidence/L4-verifiable-build.md` section 3). Mainnet needs funded keys, a multisig, a cap decision and the audit (H13, H18, H6).

**Who controls the programs?** On devnet a single key holds the upgrade authority. Moving it behind a Squads multisig with a 7-day timelock is rehearsed on LiteSVM (`tests/core/test/governance.test.ts`, ADR-0013) and needs three member keys (H13).

**Do you have users or revenue?** No external users, no revenue, no mainnet volume. The live indexer's 51 crosses and 38 priced crosses are our own test runs (`/v1/stats`, 2026-10-12). Demand validation is described plainly in the Colosseum pack, section 7.

**Why is the public devnet latency so bad?** Measured on the public devnet endpoint: bid landing p50 2,561 ms, p90 17,652 ms against a target of 5,000 ms, FAIL (`docs/evidence/DP13-devnet-latency.md`). The endpoint throttles (HTTP 429). Not measured on a paid RPC, so we cannot say whether the target is met there (HUMAN_TASKS H7, H20). Compute is a separate, measured fact: 21,633 compute units per bid for all 100,000 orders in `DP13-scale.md` (LiteSVM, not a network).

**The repository is private. Why?** It is private until a final secret scan (H21). Until it is public or access is granted to `hackathon@colosseum.com` and `dannxbt`, every repository link returns 404 to a stranger; that must be fixed before submitting.

**Is this vibe-coded or AI-built?** Most of the code was written by AI coding agents under the founder's direction; the disclosure says so (Colosseum pack section 5). What stands against the "vibe-coded" charge is evidence that can be re-run: a second implementation recomputes every cleared devnet cross (38 of 38 verified, 0 mismatched, `D5-verifier-devnet-sweep.md`), 525 conformance vectors, 100,000 real orders, refusal paths tested on devnet, and a final audit that lists 36 defects it found and fixed (`Z-final-audit.md`). HUMAN: add what you personally decided and reviewed.

## Novelty and positioning

**Isn't this just a call auction? Haven't others built that?** Yes, and we say so. Metaplex Genesis has a uniform-price auction bucket for launches (closed source), and Uncross runs a periodic call auction for tokenized stocks on devnet (`DP10-reopen-novelty.md`, `DP12-genesis.md`). We do not claim to be first or only. What the search found nowhere else: one open protocol for launches and reopens, the pool start price enforced equal to the clearing price by the program, sealed commit-reveal bids with full escrow, identity-gated trading through the same hook, an oracle guard as a print condition, and independent verification with published vectors.

**Is a second implementation really independent?** Partly. It was written from the specification (ADR-0003) rather than from the program crate, and it disagreed with nothing across 525 vectors and the devnet sweep, but both were written by the same team, so a misreading of the specification would be shared. A third party implementing the rule from the document would close that gap; the conformance suite exists for that. Also note ADR-0003's claim that truthful bidding is a dominant strategy is marked NOT VERIFIED: nothing in the repository proves it.

**Your claim that snipers get 0.03% against 10% on bonding curves?** We do not make it. `PLAN.md` quotes it from a simulation that is not in the repository, and `docs/FEATURE_STATUS.md` marks it NOT VERIFIED. It appears nowhere in the submission text.

**Why not a plain bonding curve (Rinko, Nate: "basic bonding curve slop")?** The curve is not what sets the price; the auction does, and the curve (DBC) starts at that price. Open question we should answer in person: DBC strips the transfer hook at graduation (`DP-dbc-hook-findings.md`), so post-graduation gating needs Token ACL, which does not work for DBC-created mints (ADR-0004, H9). That limit is real.

**What about holder protection and token design (Rinko, MetaDAO)?** The treasury program (`A5-treasury-devnet.md`) proves a spending allowance, attestation-gated release, lapse and liquidation with exact pro-rata redemption, with a real SAS attestation issuer being a throwaway key (mechanism proved, not a real auditor). It is a template, not a launched ownership coin; there is no indexer, API or UI for it. Milestone-locked team tokens and holder votes above the allowance are not built (`FEATURE_STATUS.md` section 6).

**Why Solana?** HUMAN, in your words. Evidence-backed facts: the call-auction state fits Solana accounts (sharded books, 21,633 compute units per bid regardless of the number of orders), and Meteora DBC, DAMM v2, DLMM, SAS and Token-2022 hooks are the composable pieces the product uses.

## Technical

**Do the sealed bids use Arcium or encryption?** No. They are commit-reveal: only a hash is on chain during the call; an unrevealed bid is excluded and refunded in full (`C2-cross-core-devnet.md`). The Arcium benchmark was never run (`DP9-arcium-benchmark.md`: blocked on devnet funds and an RPC key; no cost, latency or failure figure exists and none should be quoted).

**Does the oracle guard work?** The Pyth guard (print only if P* is within a bound of a fresh, fully verified price) is tested on LiteSVM (6 cases) and the account parser was verified against live mainnet Pyth accounts (`DP15-pyth-mainnet.md`). The pull-update proof on devnet **failed** with HTTP 401 (Hermes now needs an API key) and has not been re-run (`DP15-pyth-pull-devnet.md`, H11).

**Raydium?** Raydium's mainnet program id is not a program on devnet, so the Raydium adapter is proved with a separate devnet build of `cross_settle` under its own id (ADR-0021, `A4-raydium-cpmm-devnet.md`). The mainnet-bound build is untouched and its Raydium path is tested on LiteSVM only.

**Anything stuck on devnet?** Ten cross accounts are still Live past their close time because nobody cleared them (two from an aborted run; the verifier lists them as "not cleared", `D5-verifier-devnet-sweep.md`). Clearing is permissionless. The deployed keeper only serves crosses made by its configured creators (`W2-live-deployment.md`).

**Creating a cross: is it atomic?** No. The console sends the create transaction and then the shard transactions separately; a failure between them can leave a Live cross with missing shards that no keeper can clear. Two such crosses exist from failed attempts (`W2-live-deployment.md`, "Found, not fixed").

**Is the signed price band any good?** Not yet claimed. The calibration gate needs 30 graded crosses over 2 days and at least 9 samples for a bounded band; the live accuracy page shows status PROVISIONAL with zero coverage claimed. A graded band is scored against the cleared tick, never counted as a hit or miss until calibrated.

**Is the premium monitor reliable?** It measures real mainnet swap quotes against a reference, but values are not filtered for plausibility (some medians read like broken routes) and sessions other than "closed" are barely covered (`W2-live-deployment.md`, `premium-live.md`). Use it as a demonstration, not as data to rely on.

**Mobile?** The Android app builds, passes strict typecheck and tests and exports, but has never been run on a device (H19).

**Accessibility and performance?** Axe (WCAG 2.0/2.1 A and AA) is clean on every route in light and dark at 1440 and 390 px; Lighthouse performance 97 mobile and 100 desktop (`W1-W2-web-landing.md`). Axe does not cover WCAG 2.2, and no screen reader, Safari or Firefox pass was done.

**Known defect on our own landing page.** The tile "crosses that did not print and refunded everyone" reads 0, because `/v1/stats` counts only state `NoPrint`, while finalized crosses that never printed stay `Finalized` (the live API lists 10 finalized crosses with no clearing price, and the verifier confirmed `24X89kV5…` as a no-print, BelowMinimumVolume). Do not quote that tile.

## Business and legal

**What is the business?** A protocol fee on filled volume charged to the sell side: the smaller of the schedule (30 bps launches, 5 bps reopens, 15 bps tenders) and a quarter of the integrator's fee, never on bids, cancels or refunds (ADR-0010). The numbers are proposed and have not been modelled. No revenue.

**Securities and regulation (stock tokens, revenue shares, India)?** Open. Nothing on the site is an offer of securities. Counsel has not been engaged (H1, H2); a written opinion per asset class is required before any public-money mainnet cross. For an Indian team: FIU-IND registration and ODI/FEMA rules are on the H1 and H2 list.

**How will you get users (Max's question)?** The plan is in the Colosseum pack section 6: integrators through SDK and CPI, free first crosses for hackathon teams, public goods (verifier, track record). It is a plan; nothing has been executed (H8).

**What is the biggest reason this fails (Mitchell's question)?** HUMAN, in your words. Evidence-based candidates: no issuer or venue adopts it because a uniform-price call auction is a known idea with incumbents; legal clearance for stock tokens is slow; the mainnet path depends on an audit and a multisig that do not exist yet.

**Why should a Meteora judge care when you have no mainnet traction?** Because the depth is real and checkable: four Meteora programs driven by real CPIs on devnet, with refusals tested (`meteora-dbc-pack.md`). The listing prefers mainnet projects; this one is not, and the pack says so. Whether devnet-only is eligible must be confirmed with Meteora (Meteora pack section 3.4).
