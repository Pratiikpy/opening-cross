# W3E: routes that open a market, Meteora's programs, issuer neutrality and the keeper's duties

Date: 2026-10-14. Reference: `docs/api/W3E-markets-keeper-neutrality.md`. Decisions: ADR-0700 to ADR-0703. The extended programs are proved on LiteSVM and a local validator and are not deployed to devnet (H27). Nothing here sent a transaction.

## Verification run

| Package | Command | Result |
|---|---|---|
| packages/adapters | `tsc`, `vitest run` | 28 passed (7 new: `checks.test.ts`) |
| packages/sdk | `tsc`, `vitest run` | 22 passed (10 new: `series-schedule.test.ts`) |
| packages/client | `tsc`, `vitest run` | 31 passed (1 new: every new method calls the route the API registers) |
| services/mcp | `tsc`, `vitest run` | 56 passed (7 new tools, each checked against a registered route) |
| services/keeper | `tsc`, `vitest run` | 76 passed (44 new: `duties.test.ts` 22, `duties-run.test.ts` 22) |
| services/api | `tsc`, `vitest run` | 371 passed, 98 skipped (need Postgres); new files `settle-open-tx` 26, `meteora-tx` 23, `challenges` 4; extended `settle-tx` 4, `rules-tx-after` 6, `treasury-tx` 13; `boot-all` passes with the three new route groups registered |
| tests/core `agent-skill.test.ts` | `vitest run` | 7 passed (reads `server.ts` only; unaffected) |
| apps/web `llms.test.ts` | `vitest run` | 11 passed (reads four named route files; unaffected, and does not yet know the new ones, see below) |

## Against the chain

Read-only, Solana devnet, 2026-10-14.

- **Account decoders** (`meteora-tx.ts`): 8 Alpha Vaults and 8 Met Lock escrows were read with `getProgramAccounts` (filter on the account discriminator) and decoded; for all 16 the address was re-derived from the decoded fields (vault from `base` and `pool`, escrow from `base` and the mint, whose owner matched the escrow's token-program flag) and equalled the account's address. The vault mode byte is 0 for the three pro-rata and 1 for the five first-come vaults among them, each with its cap in the matching field. The fee-sharing vault of `D7-fee-sharing-vault-devnet.md` (`4LRUCppRsAVnHBPKB5kSpJsUSqMbr55NABJf6XcjpHff`) decoded to 10,000 total shares, 492,631 funded, 246,315 claimed by each of two recipients and token vault `8dTkW2Vs…`, as that document records. Five of these accounts are the fixtures of `meteora-tx.test.ts`.
- **Transactions built by the routes, simulated against the real programs** (`simulateTransaction`, `sigVerify: false`, unsigned): `POST /v1/tx/metlock-claim` for a funded recipient of a Token-2022 escrow: Met Lock `success`, 29,714 compute units of 1,381,810 (four other escrows tried had recipients with no lamports, so the simulation stops at `AccountNotFound` for the fee payer before reaching the program; three were refused by the route: two with nothing vested, one whose mint no longer exists). `POST /v1/tx/fee-share-claim` for the second recipient of the D7 vault: the compute-budget, associated-token and Dynamic Fee Sharing programs all `success`.

## Per row

`H27` is the only external step for the programs. The screens are 3F's; what each row needs from them is the last column.

| Row | What exists now (tests) | Remaining | 3F consumes |
|---|---|---|---|
| W2, V-E adapters; D3; D1; F4/B15; W10; X12/C1 | `open-dbc-pool` (locked design checked, open and bind atomic when they fit: 1,119 bytes; `designIssues`), `bind-dbc-mint`, `seed-damm-v2` (plain, batched with `landBy`, Alpha Vault flag, permanent lock, vesting), `open-dlmm-pair` (plain, batched, badged), `seed-raydium-cpmm`, `GET /v1/crosses/:address/venues`; release gate, size check, compute limit; 26 + 7 tests | No transaction run against `cross_settle` (not deployed); screen | `POST` bodies and `available` of `venues` (API doc) |
| X13/R2, B4 (Alpha Vault, Met Lock) | Alpha Vault init, deposit, fill, claim, withdraw and read; Met Lock create, claim and read; decoders verified on 16 real accounts; Met Lock claim simulated on the real program; 23 tests | Alpha routes not simulated anywhere (no vault belongs to a cross); DLMM fill not built; Presale Vault not integrated; screen | `GET .../alpha-vault`, `GET /v1/metlock/escrows/:escrow`, the tx routes |
| D7 fee sharing | create, fund, claim, hand the DAMM v2 position over (one way, guarded), pull its fees in, read; claim simulated on the real program | **DBC creator and partner bridges are not built and cannot be offered for a pool this protocol opens (ADR-0701)**; claimable amounts not computed; screen | `GET /v1/fee-share/:base/:mint`, the tx routes |
| B5 refunds | Keeper duty `refunds` batches refund-only orders (12 per transaction); exactness argued from the program and tested at every boundary; falls back to claims | Screen for pushing is not needed; LiteSVM/devnet run of the keeper | none |
| B12 anti-flip | Keeper duty `locks` (opt-in) releases vested lockups | Needs an operator who accepts paying a first token account | none |
| VM7 issuer neutrality | `GET /v1/arbiter`, `GET .../challenge-state`; window, ruler and deadline checked before signing; keeper duty `challenges` closes challenges after 14 days and holds `finalize` back with the reason | The arbiter is unnamed (H28); no screen for the arbiter's ruling | `GET /v1/arbiter`, `GET .../challenge-state`, `POST /v1/tx/resolve-challenge` |
| Y1 recurring cross | `spawn-next` makes the program's checks (`SPAWN_TOO_EARLY` with the second, `PREVIOUS_LIVE`, ...); keeper duty `series` (opt-in) spawns and creates the shards; schedule ported and tested | The rent of spawned crosses is not reclaimed; no screen creates or runs a series | `spawn-next` answer: `closeTs`, `openTs`; `GET /v1/series/:address` |
| W11 halt-resume | Keeper duty `halts` runs `sync_pause` (both directions) and `observe_price` before the crosses are cleared; the clear is given the halt state and a flagged corporate action; reports `HALTED` and `CORPORATE_ACTION` | The keeper cannot lift a halt or flag a corporate action (only the authority and a printing resume cross can); no price poster; no screen operates a halt | `GET /v1/halts/:baseMint` |
| E7 wind-down | `docs/runbooks/treasury-wind-down.md` rewritten from the program source: first release and extension apart, the window, what is refused and what works in it, the sweep, `WoundDown`; `redeem` answers 409 `WOUND_DOWN` after the sweep | Funds are not pushed to holders; the window cannot be run on a real clock; no runbook run on a deployed extension | `terms.windDown`, `live.windDown` of `GET .../ext` |

Proposed wording for the Gap column, where it changes (the owner of `FEATURE_STATUS.md` decides): Y1 "the keeper spawns the next cross and creates its shards (opt-in duty `series`; the spawner pays the rent, which is not reclaimed)"; B5 "the keeper sends `push_refunds` for orders it can prove refund-only (default duty), and claims the rest"; VM7 "the keeper closes unanswered challenges; the routes check the window, the ruler and the deadline before signing"; W11 "the keeper copies a mint's pause into the halt state and feeds the breaker a verified update; it cannot lift a halt"; E7 delete "the runbook still describes the deployed program" and the Open line; X13/R2, F4/B15, W10, X12/C1, B4: replace "SDK-only / no API route" by "routes exist (`W3E`), no screen".

## For the owners of the files that list routes

- `apps/web/test/llms.test.ts` reads a fixed list of route files. For the new routes to be documented and tested there, add `settle-open-tx`, `meteora-tx` and `challenges` to `routeFiles` and the routes below to `apps/web/public/llms.txt` and `llms-full.txt` (the test fails if a registered route is undocumented once the files are listed, and passes today because the files are not listed): `POST /v1/tx/open-dbc-pool`, `bind-dbc-mint`, `seed-damm-v2`, `open-dlmm-pair`, `seed-raydium-cpmm`, `alpha-vault-init`, `alpha-vault-deposit`, `alpha-vault-fill`, `alpha-vault-claim`, `alpha-vault-withdraw-remaining`, `metlock-create`, `metlock-claim`, `fee-share-create`, `fee-share-fund`, `fee-share-claim`, `fee-share-transfer-position`, `fee-share-fund-from-damm`; `GET /v1/crosses/:address/venues`, `/alpha-vault`, `/challenge-state`, `/v1/metlock/escrows/:escrow`, `/v1/fee-share/:base/:mint`, `/v1/arbiter`.
- `docs/agent-skill/opening-cross/SKILL.md` names the MCP read tools in its "MCP server" paragraph; the seven new ones are `oc_get_cross_venues`, `oc_get_program_release`, `oc_get_alpha_vault`, `oc_get_metlock_escrow`, `oc_get_fee_share_vault`, `oc_get_arbiter`, `oc_get_challenge_state`. `tests/core/test/agent-skill.test.ts` scans `server.ts` only and is unaffected by routes in route files.

## Not covered

- No instruction of the extended programs was run: not on LiteSVM (no native module on Windows), not on a validator, not on devnet. The in-memory chain of the keeper tests and the routes' fixtures are written from the program source; they test the keeper and the routes, not the programs.
- `open_dbc_pool` with `locked: false` uses the nested argument layout, known from the regenerated clients; a deployed program with the old layout is refused by the gate on the absence of `open_dbc_pool_locked`, not by a layout test.
- Alpha Vault routes, `seed-damm-v2`, `open-dlmm-pair`, `seed-raydium-cpmm`, `fee-share-fund`, `fee-share-transfer-position` and `fee-share-fund-from-damm` were never simulated against a real program. `metlock-create` was not simulated either (no devnet wallet with a Met Lock-compatible mint was used).
- The release gate was exercised on fabricated ProgramData, not on the extended `cross_settle` binary (none is on disk or on devnet).
- The treasury runbook was written from the source and checked against the API's routes; no extended treasury exists on a cluster to follow it on.
- The keeper `series` duty's calendar path uses `calendarSessions` without an owner check (the program checks it); a series pointing at a foreign calendar fails at the program every pass.
- Pyth `observe_price`: no feed account was read from a cluster; `KEEPER_BREAKER_FEEDS` depends on the push oracle keeping the account fresh.
- No UI. `tests/devnet`, `apps/web`, `apps/mobile`, `programs/**` and the generated clients were not touched.
