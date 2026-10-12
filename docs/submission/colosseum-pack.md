# Pack 1: Colosseum Crypto World's Fair (Solana track, overall awards, Accelerator)

Source of every rule below: `Colosseum Worldsfair.md` (capture of 2026-10-03), re-checked against the live pages on 2026-10-12 (rules PDF identical word for word; FAQ unchanged; see [README](README.md)). Deadline: **11:59pm PT on 12 Oct 2026 (= 06:59 UTC and 12:29 IST on 13 Oct)**. Registration of every member and the team leader's upload must both be done before then (Rules section 6).

Prizes this project competes for: Solana track $100,000 (10 x $10,000); overall Grand Champion $30,000, next 20 teams $15,000 each, Public Goods $5,000, University $5,000 (track prizes are in addition); every winner is interviewed for the Accelerator ($250,000 pre-seed, 12 weeks in San Francisco, Solana integration required).

## 1. Submission fields (final text)

The portal sits behind a login (`colosseum.com/arena/hackathon`), so its exact form cannot be read from outside: the field list below is the one the FAQ states ("What is the required information in the submission portal?"). Any extra field the portal shows is NOT VERIFIED here. HUMAN means only Prateek can supply it.

| Field (FAQ wording) | Final value |
|---|---|
| Product name | `Opening Bell` (the app). The open protocol under it is `Opening Cross`. |
| One-line pitch | One fair price for every new market on Solana. |
| Short description (about 280 characters) | Opening Bell opens new markets on Solana at one fair price. Orders are escrowed on chain; at the close every filled order pays a single clearing price that anyone can recompute, and the market then opens on Meteora at that price. Devnet today; open protocol, Apache-2.0. |
| Long description | Section 2 |
| Blockchains and tools integrated | Section 3 |
| Teammates with backgrounds | Section 4 (HUMAN) |
| Team location | India. HUMAN: city. |
| Logo or graphic | `docs/submission/assets/logo-1024.png` (1024 x 1024 mark, derived from `apps/web/src/app/icon.svg`); share graphic `docs/submission/assets/og-1200x630.png` (the site's Open Graph card, captured from the live site) |
| GitHub repository | https://github.com/Pratiikpy/opening-cross. Private today (**H21**). Either make it public after a secret scan or grant read access to `hackathon@colosseum.com` (the FAQ's wording) and also `dannxbt` (Meteora's rule). A private link nobody can open scores as no repository. |
| Pitch video (2 to 3 minutes) | HUMAN: uploaded link. Script and shot list: [`video/pitch-script.md`](video/pitch-script.md) |
| Product demo video (at most 3 minutes) | HUMAN: uploaded link. Script and shot list: [`video/demo-script.md`](video/demo-script.md) |
| Go-to-market and demand validation | Section 6 and section 7 |
| Pre-existing code disclosure | Section 5 |
| Website | https://opening-bell-psi.vercel.app (live on Vercel; the backend runs on AWS) |
| X account | HUMAN: none exists (HUMAN_TASKS H7). Colosseum recommends building in public from the start; create it before submitting and post the weekly update ([`video/weekly-update.md`](video/weekly-update.md)). |
| Weekly update videos | None were made for 14 Sep to 4 Oct. Do not backfill them as if recorded then. Record one now (outline in `video/weekly-update.md`). |
| Track | The Solana track ($100,000). HUMAN: whether the portal asks you to choose a track is NOT VERIFIED; if it does, pick Solana. |

### 2. Long description (paste)

> **The problem.** When a new asset opens for trading (a token launch, a tokenized stock after the weekend, an unlock), the price goes to whoever is fastest. Books are thin, bots win the first block, and nobody agreed to the price.
>
> **What we built.** Opening Cross is an open call-auction protocol on Solana. Orders are escrowed in a program-owned vault while the cross is open. When it closes, one price is found where demand meets supply, and every filled order pays that single price; order size buys quantity, not a better price. Unfilled money is refunded, and a cross that does not print refunds everyone. Opening Bell is the app: a web app and an Android app for investors and issuers.
>
> **What makes it checkable.** The clearing rule is one `no_std` crate used by the program and by a generator of 525 conformance vectors. A second implementation, written from the specification, recomputes any cross from its on-chain book and emits a fairness proof. It matched the program on every cleared devnet cross we tested.
>
> **Where the market opens.** After a launch, `cross_settle` opens a Meteora DBC pool whose start price is the clearing price (the program refuses any other), or seeds a DAMM v2 pool or a DLMM pair at that price, or a Raydium CPMM pool. Token transfers can be gated by identity (Solana Attestation Service passes) through a transfer hook.
>
> **Trust layer.** Price bands signed before a cross closes and graded against the result, anchored on chain, with misses counted; a monitor of real stock-token swap costs; a check of whether a token is the issuer's real one.
>
> **Status, honestly.** Solana devnet only. No mainnet deployment, no external audit, no external users yet. Five programs are deployed on devnet and equal the local builds byte for byte. See the repository's `docs/FEATURE_STATUS.md` for what is built and what is not.

(About 330 words. Every claim in it traces to an evidence file in section 8.)

### 3. Chains and tools

- **Chain:** Solana (devnet). Nothing is deployed on any other chain.
- **Meteora:** Dynamic Bonding Curve, DAMM v2, DLMM (all three proved on devnet; see [meteora-dbc-pack.md](meteora-dbc-pack.md)); Presale Vault proof.
- **Other protocols called:** Raydium CPMM (devnet build), Solana Attestation Service, Pyth (oracle guard on mainnet reads; pull proof not yet run, see FAQ), Token-2022 transfer hooks and Token ACL, Jupiter (read-only price quotes in the router and premium monitor), SPL Memo (anchoring of signed bands).
- **Not used, so not claimed:** Arcium (the benchmark was never run, `DP9-arcium-benchmark.md`), MetaDAO (adapter not built), any other chain.
- **Stack:** Anchor 1.0.2 programs in Rust 1.96.1, Agave 4.0.2, `@solana/kit` and Codama clients, LiteSVM tests, TypeScript SDK, Postgres 17 indexer, REST and WebSocket API, MCP server for agents, Next.js and Tailwind web app, Expo Android app with Mobile Wallet Adapter, Remotion film. Refresh this line from `README.md` and `BUILD.md` before pasting if the stack changed.

## 4. Team (HUMAN: only Prateek can fill this)

Colosseum states it evaluates "founder-market fit, how the opportunity was uncovered, how the team prioritizes, and whether the founders are committed to building a venture-scale business". Judges' public checklists also flag part-time teams and outsourced work (`JUDGE_PSYCHOLOGY.md`). Nothing in the repository tells us the answers, so none are written here.

| Slot | Fill in |
|---|---|
| Founder name, role, hours per week (state full-time or not) | HUMAN |
| Background relevant to markets, exchanges, auctions, tokenization or Solana (employers, shipped products, links) | HUMAN |
| Why this problem: the moment you saw an opening price go wrong | HUMAN (the pitch script has a slot for it) |
| Other members, each registered on colosseum.com | HUMAN; the portal needs every member registered and added by the team leader |
| Who wrote the code | Repository history: 68 commits by one GitHub account (`Pratiikpy`), first commit 2026-10-05. HUMAN: state your role plainly, and see section 5 on AI assistance. |

## 5. Disclosure of pre-existing code and third-party work (paste, after HUMAN review)

> **Pre-existing code.** None. The repository's first commit is 2026-10-05, inside the contest period (14 Sep to 12 Oct 2026); there is no earlier version of this code in any other repository. Planning and research documents (specification, competitor and judging research) were written before and during the contest and are in `research/` and the repository root; they are not shipped product code.
>
> **Open-source and third-party code we compose with, not our own work:** Meteora DBC, DAMM v2 and DLMM, Raydium CPMM, Solana Attestation Service and Pyth are called through their deployed programs and published SDKs (their binaries are fetched for tests by `tests/fixtures/fetch.sh` and are not redistributed); Anchor, LiteSVM, `@solana/kit`, Codama, Next.js, Remotion and other libraries as listed in the lockfiles. The visual design started from two HTML design exports generated with an AI design tool; every screen was rebuilt in the application with real data, and illustrations are labelled "Illustration" or "Example".
>
> **AI assistance.** Most of the implementation was written by AI coding agents (Claude Code) under the founder's direction, with decisions recorded in `docs/adr/` and `CLAUDE.md`. HUMAN: state in one sentence what you decided, reviewed and tested yourself.

Why this wording: the FAQ makes misrepresenting development history grounds for disqualification, banning and revoked prizes, and says it wants to see that the team did the work "rather than a third party". Disclosing AI assistance is the safe, true position. Remove or edit only if it is not accurate.

## 6. Go-to-market (paste)

> **Wedge.** We do not ask every venue to adopt a new app. The protocol is called by other venues in one step: a TypeScript SDK, a Rust CPI crate (`opening-cross-cpi`, with a third-party example program that forwards a user's order into a cross in one CPI), a REST and WebSocket API, and an MCP server for agents. Our own app, Opening Bell, is the first venue.
>
> **First markets.** (1) Launches for teams that want a price set by demand and an open market on Meteora at that price. (2) Reopens of tokenized stocks after weekends and halts, where thin books make the first trade unfair; the exchange calendar and an oracle print-guard exist for this. Related work exists on both (Metaplex Genesis for launches, Uncross for stocks on devnet); we position as the open protocol that covers both and can be checked independently.
>
> **Distribution plan (not yet executed).** Recruit named testers and a first issuer (HUMAN_TASKS H8); offer free first crosses to Colosseum and Superteam teams; publish the verifier, the signed track record and the premium monitor as public goods so the numbers can be quoted by others; integrate through the SDK and CPI with existing launchpads rather than competing for their users.
>
> **Revenue.** A protocol fee on the sell side of filled volume, the smaller of the schedule (30 bps launches, 5 bps reopens, 15 bps tenders) and a quarter of the integrator's fee, so integrators earn more than we do; never charged on bids, cancels or refunds (ADR-0010; the schedule is proposed and has not been modelled). No revenue yet.
>
> **Sequence to traction.** External testers on devnet, then a capped mainnet cross with named issuers after an external audit and legal review. Mainnet needs funded keys, a multisig and counsel; those steps are named in `docs/HUMAN_TASKS.md` (H1, H2, H6, H13, H18).

## 7. Demand validation (paste, and read the caveat)

> We have **not** yet validated demand with external users, and we say so. What exists: (1) market evidence from our own research that the thin-opening problem is real: on 16 September Jupiter found no route to buy a tokenized IBM share at $1, $100 or $10,000 against a $1,666 pool (a measurement published by the Uncross team, cited in our `DP10` note), and weekend tokenized-stock volume is reported in the billions per weekend; (2) two independent teams (Metaplex with a launch auction, Uncross with a stock-reopen auction) have already built call auctions on Solana, which shows the mechanism is wanted but also that we are not first; (3) a working, publicly checkable product on devnet that any stranger can verify in one command. What does not exist: signed letters of intent, a waitlist, mainnet volume, retention data, or revenue.

Caveat for Prateek: Colosseum asks for "demand validation" and lists traction among the factors. Anything you can add truthfully before submitting (a named issuer who agreed to a pilot, testers who placed bids, a message from a launchpad that wants the SDK) will outweigh everything above. Do not add anything that is not true; the FAQ treats misrepresentation as grounds for disqualification. Slot: HUMAN.

## 8. Judging criteria mapped to evidence

Rules section 8 criteria first, then the FAQ factors. "Evidence" paths are under `docs/evidence/` unless stated.

| Criterion | Our case | Evidence | Honest limit |
|---|---|---|---|
| Functionality: how well does it work, code quality | Five programs deployed on devnet and equal to the local builds byte for byte; full cross lifecycle (create, bid open and sealed, clear, claim, refund, finalize) on devnet; three keepers racing with one killed mid-work still finish four crosses of every shape; 100,000 real orders at 21,633 compute units each, settled in 33 transactions | `C2-cross-core-devnet.md`, `D2-keeper-devnet.md`, `DP13-scale.md`, `L4-verifiable-build.md` | Public devnet RPC throttled landing latency to p90 17,652 ms against a 5,000 ms target (`DP13-devnet-latency.md`, FAIL); not measured on a paid RPC. No external audit. |
| Potential impact: TAM, ecosystem impact | New listings, unlocks, reopens of tokenized stocks and launches all need an opening price; Solana tokenized equities are growing (third-party figures only, see section 7). Open protocol, so other venues can adopt it. | `DP10-reopen-novelty.md`, `PROBLEMS_AND_SOLVERS.md` | Market size is argued, not measured. No external adopter yet. |
| Novelty | Not the auction itself (prior art exists and is cited). New: one open protocol for launches and reopens; the pool start price enforced equal to P* by the program; sealed commit-reveal with full escrow and refund of unrevealed bids; independent verification with published conformance vectors; signed, graded, anchored price bands that count misses. | `DP10-reopen-novelty.md`, `DP12-genesis.md`, `D5-conformance.md`, `T-trust-devnet.md` | No claim of first or only. Arcium private bids not built. |
| UX: great UX for downstream users | Browse without a wallet; any Wallet Standard wallet; funds escrowed non-custodially with free cancel; every state shows what the chain proves; light and dark; axe clean on every route at 1440 and 390 px; Lighthouse mobile 97 and desktop 100 (performance) | `W1-W2-web-landing.md`, `Z-final-audit.md` | Axe covers WCAG 2.1 AA only. No real-device, Safari, Firefox or screen-reader test. Android app not yet run on a device (H19). No usability study. |
| Open source and composability | Apache-2.0; SDK, Rust CPI crate, REST and WebSocket API, MCP server; third-party venue example; composes with Meteora, Raydium, SAS, Pyth, Token-2022 | `D4-sdk-and-cpi.md`, `D5-conformance.md`, repository `LICENSE` | Repository private until H21. Packages not on npm or crates.io (H12). |
| Business plan: viable business, can the team execute | Fee schedule with integrator share, sequence to mainnet, named dependencies | `docs/adr/0010-fee-model.md`, `docs/HUMAN_TASKS.md` | Figures proposed, not modelled. No revenue, entity, counsel or audit yet. |
| Founder and market fit | HUMAN | none | Only the founder can answer. |
| Insight | Opening prices are set by speed; a uniform price plus escrow plus independent recompute removes the race and makes the result checkable. The insight that stock tokens need a reopen price after a closed market is backed by the third-party observation in section 7. | `DP10-reopen-novelty.md` | |
| Product plus execution, shipping speed | 68 commits between 2026-10-05 and 2026-10-12 (count at the time of writing), every defect found by running it is recorded with its fix | `Z-final-audit.md`, `docs/PROGRESS.md` | Single account in the history. |
| Founder communication | The pitch and demo videos | `video/` scripts | Videos not yet recorded: HUMAN. |
| Viability | Fee design and sequencing above | ADR-0010 | Legal and regulatory work for stock tokens and revenue-share tokens is open (H1, H2). |
| Traction | None on mainnet; devnet activity from our own runs only | live `/v1/stats` | State it plainly. |

## 9. Accelerator preparation

Winners are guaranteed an interview, not admission (about 0.7% acceptance per the Accelerator page). The interview is 15 minutes on Zoom. Solana integration is required (met). Prepare answers to [`faq-for-judges.md`](faq-for-judges.md); the questions judges' public posts imply are in `JUDGE_PSYCHOLOGY.md` (Mitchell: "biggest reason this could fail?"; Max: "how will you get users?"; Julian Ma: "why Solana?"; Rinko: attack on token design; Dean: traction and go-to-market).

## 10. Submit checklist for this target

See [`checklist.md`](checklist.md), section "Colosseum".
