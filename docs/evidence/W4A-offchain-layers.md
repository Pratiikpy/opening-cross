# W4A: the off-chain layers of the seven Wave 3D programs and the two batch 2 settle instructions

Date: 2026-10-16 (the work is commit `9099541`, 2026-10-15; the test counts below were re-run on 2026-10-16). ADR-0800 to ADR-0804. API reference: `docs/api/W4A-new-programs.md`. The screens built on these layers are in `W4B-screens.md`.

**Status.** The programs (`cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing`, `cross_graduate`), `cross_settle::open_fixed_price_presale`, `cross_settle::seed_futarchy_dao` and the fifth rule flag of `cross_core` are proved on LiteSVM and on a local validator (`W3D-*.md`). They are NOT deployed to devnet (H27 for the batch 2 upgrade, H43 for the seven programs). Nothing in this file ran against a cluster that has them.

## What was built, per program

Common to all seven: migration `services/indexer/migrations/019_wave3d_programs.sql` (additive, idempotent; `program_events` plus the tables named below), indexer decoding in `services/indexer/src/programs.ts` and `programs-events.ts` (one cursor per program, `rpc:<program id>`, `WAVE3D_PROGRAMS` chooses which), SDK builders in `packages/sdk/src/programs/<program>.ts`, the mirror in `packages/client/src/api.ts`, diagnose tables for the programs' error names (`packages/diagnose`), every transaction route answering 409 `PROGRAM_NOT_DEPLOYED` when the cluster lacks the program or the instruction (`routes/programs-support.ts`, ADR-0800), and `GET /v1/programs` with a `features` map (`routes/programs-catalog.ts`).

| Program | Routes (`services/api/src/routes`) | Indexer tables | Keeper duty | MCP tools (`services/mcp/src/tools.ts`) |
|---|---|---|---|---|
| `cross_mandate` | `mandate-tx.ts`: 10 transaction routes (create, fund, set-limits, revoke, withdraw, withdraw-lamports, sweep, place-order, cancel-order, reveal-order), `POST /v1/mandates/check-transaction`, 4 reads | `mandates`, `mandate_orders` | none | `oc_get_mandate`, `oc_list_mandates`, `oc_get_mandate_activity`, `oc_check_agent_transaction`, `oc_draft_mandate_place_order`, `_cancel_order`, `_reveal_order`, `_revoke`, `_withdraw` |
| `cross_conviction` | `conviction-tx.ts`: 4 transaction routes (lock, unlock, claim-badge, close-lock), 3 reads | `conviction_locks`, `conviction_badges` | none | `oc_get_conviction`, `oc_get_conviction_lock` |
| `cross_basket` | `basket-tx.ts`: 3 transaction routes (create, mint, redeem), 3 reads including the quote | `baskets` | none | `oc_get_basket`, `oc_quote_basket`, `oc_list_baskets` |
| `cross_listing` | `listing-tx.ts`: 7 transaction routes (create-venue, open-bond, deposit-bond, withdraw-bond, list-cross, release, slash), 5 reads | `listing_venues`, `listing_bonds`, `listing_listings` | `listings` (release or slash; named only) | `oc_get_listing_venue`, `oc_get_listing`, `oc_get_cross_listings` |
| `cross_bounty` | `bounty-tx.ts`: 5 transaction routes (create, fund, claim-invariant, award, withdraw), 4 reads including `GET /v1/crosses/:address/invariants` | `bounties`, `bounty_payouts` | `bounties` (claim a broken invariant to the keeper's wallet; named only) | `oc_get_bounty`, `oc_list_bounties`, `oc_get_cross_invariants` |
| `cross_backing` | `backing-tx.ts`: 4 transaction routes (init-halt-state, create-policy, attest, check), 2 reads | `backing_policies`, `backing_attestations`, `backing_failures` | `backing` (`check` an opted-in asset; on by default) | `oc_get_backing` |
| `cross_graduate` | `graduate-tx.ts`: 7 transaction routes (init-charter, start-round, cast-vote, post-volume, finalize-round, publish-outcome, withdraw-vote), 2 reads | `graduation_charters`, `graduation_rounds`, `graduation_votes`, `graduation_outcomes` | `graduation` (finalize a closed round, publish a passed outcome; on by default) | `oc_get_graduation`, `oc_get_graduation_round` |
| `cross_settle` fixed-price presale and MetaDAO DAO | `settle-wave3d-tx.ts`: `open-fixed-price-presale`, `seed-futarchy-dao`; the DAMM v2, DLMM and Raydium seeding routes gain the graduation gate (409 `GRADUATION_NOT_APPROVED`) | none (see below) | none | none (`oc_get_program_release` reports the two as features) |
| `cross_core` governed-graduation flag | `rules-tx.ts` and `holder-programs.ts` accept flag 32; `create-cross-ruled` is refused with 409 while the seeding could never succeed | none (the flag lives in the existing rules decoding) | none | `oc_get_program_release` |

Also built: `oc_get_program_release`; the `services/backing-attester` service (signs `cross_backing` statements from reserve token accounts, an HTTP custodian report or a report file; posts only a dated, fresh figure; holds a figure far above the last for an operator; `ATTESTER_DRY_RUN`); the agent skill `docs/agent-skill/opening-cross/SKILL.md`; the `llms.txt` and `llms-full.txt` entries; `docs/CONFIGURATION.md` entries for `WAVE3D_PROGRAMS`, the `KEEPER_DUTIES` additions and the attester (`RPC_URL`, `ATTESTER_KEYPAIR`, `ATTESTER_CONFIG`, `PASS_MS`, `ATTESTER_DRY_RUN`). Keeper duties are pure planners over account data the keeper has just read (`services/keeper/src/program-duties.ts`) and a runner (`program-passes.ts`); `KEEPER_DRY_RUN=1` plans without sending; a scoped keeper (`KEEPER_CREATORS`) narrows graduation and listings.

## Tests, re-run on 2026-10-16

Each command was run from the package directory with `npx vitest run <files>`; counts are from the JSON reporter. No test was skipped.

| Package | File | Passed |
|---|---|---|
| `services/api` | `backing-tx.test.ts` | 7 |
| | `basket-tx.test.ts` | 7 |
| | `bounty-tx.test.ts` | 7 |
| | `conviction-tx.test.ts` | 7 |
| | `graduate-tx.test.ts` | 8 |
| | `listing-tx.test.ts` | 6 |
| | `mandate-tx.test.ts` | 24 |
| | `settle-wave3d-tx.test.ts` | 8 |
| | `indexer-wave3d.test.ts` (PGlite) | 11 |
| | `mcp-wave3d.test.ts` (every read tool against the whole API server) | 1 |
| | `wave3d-docs.test.ts` | 7 |
| | `wave3d-release.test.ts` | 9 |
| | `holder-programs.test.ts` | 10 |
| | api subtotal | 112 |
| `packages/sdk` | `programs.test.ts` | 30 |
| `packages/adapters` | `wave3d.test.ts` (presale and futarchy builders) | 9 |
| `packages/client` | `wave3d.test.ts` | 27 |
| `packages/diagnose` | `wave3d.test.ts` | 13 |
| `services/keeper` | `program-duties.test.ts` | 13 |
| | `program-passes.test.ts` | 20 |
| `services/mcp` | `wave3d-tools.test.ts` | 29 |
| `services/backing-attester` | `attester.test.ts` | 20 |
| `apps/web` | `llms.test.ts` | 11 |
| Total | | 284 passed, 0 failed |

The full per-package suites (everything else in each package) were not re-run for this file, and `tsc` and `cargo` were not run.

## What was not covered

- No route, indexer decoder, keeper send or attester send ran against a cluster that has the programs. The route tests run against an in-memory chain (`services/api/test/helpers/wave3d.ts`) that decodes the built transaction and does not execute the program; the indexer tests decode logs encoded with the generated clients, over PGlite and not Postgres; the keeper tests run against an in-memory chain that applies what the keeper sends (`services/keeper/test/helpers/world3d.ts`).
- The indexer has no projection for `FixedPricePresaleOpened` or `FutarchyDaoSeeded` (migration 019 has no table for either), so the settlement read does not list a tranche or a DAO. No MCP tool drafts the two `cross_settle` instructions.
- There is no keeper duty for mandates, conviction or baskets; none applies, since each is initiated by its owner or holder.
- The `listings` and `bounties` duties are not on by default (a slash may fund an account; a claim pays the keeper's wallet), so a keeper runs them only when an operator names them.
- The attester was tested against fixtures, not a live custodian. Which attesters count is an operator decision (H32).
- The fifth rule flag cannot be seen in the program bytes, so `/v1/programs` reports it under `unverified`.
- Transaction size and compute of the new instructions were not measured on a cluster; a basket of more than about five components is expected to need an address lookup table (the basket page says so, `W4B-screens.md`).
- Not audited.
