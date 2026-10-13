# ADR-0700: The routes that open a market, and refusing an instruction the deployed program lacks

Status: accepted (2026-10-14). Reverses the last paragraph of ADR-0505 ("Not routed"). Builds on ADR-0480 to ADR-0485, ADR-0600.

## Context

ADR-0505 left the instructions that open a venue (`open_dbc_pool_locked`, `seed_damm_v2`, `seed_damm_v2_batched`, `open_dlmm_pair`, `_batched`, `_badged`, `seed_raydium_cpmm`) to the issuer's tooling, on the argument that an HTTP body for a curve design is a second place to get it wrong. The screens need them: an issuer's settle page cannot ask for a script. And every route that builds an instruction the deployed program lacks hands out a transaction the program refuses with `InstructionFallbackNotFound`, which the caller sees only after signing.

## Decision

1. **The openings are routes** (`routes/settle-open-tx.ts`): `open-dbc-pool`, `bind-dbc-mint`, `seed-damm-v2`, `open-dlmm-pair`, `seed-raydium-cpmm`, and a read, `GET /v1/crosses/:address/venues`. They call the adapters' builders, so there is one construction. The design is JSON with numbers and booleans only (every DBC enum is numeric; a string is a 400), top-level keys are a whitelist, and the SDK's own validation turns into 422 `DESIGN_INVALID`.
2. **The program's checks are repeated before signing, in one place** (`packages/adapters/src/checks.ts`): `checkLockedDesign` is `design::check_locked_design` and returns every departure with the program's error name; `checkBatchStart` and `checkBatchedPoolFee` are `batch::check_batched_pool` / `check_batched_pair` (window 30 s to 7 days, a start at least the window away, a fee that decays on a timer, read from the same 27 bytes DAMM v2 reads). Each case of the Rust unit tests is a case of `checks.test.ts`. The program stays the authority; the route is a courtesy that names the reason.
3. **A release gate** (`routes/program-gate.ts`): the instruction's 8-byte discriminator is searched in the ProgramData account the way `GET /v1/programs` does (ADR-0600). Present: build and say `deployed: true`. Absent, with a control instruction every release has found: 409 `PROGRAM_NOT_DEPLOYED { program, instruction }`. Not readable, or the control not found: build and say `deployed: null`; an unreadable program is never reported as an old one. The same gate is applied to the payouts and the greenshoe in `settle-tx.ts`.
4. **`open_dbc_pool` is gated on `open_dbc_pool_locked`.** The instruction name `open_dbc_pool` is in every release, but its arguments were nested in the build that added the locked variant (W2D-D3): an older program has the same discriminator and the old layout, which a discriminator scan cannot tell apart. The locked instruction is the mark of the new layout, so either variant is refused without it.
5. **Compute and size.** Every transaction starts with a 1,400,000-unit compute limit (what tests/core runs these instructions with) and is measured against 1,232 bytes: 422 `TX_TOO_LARGE`. The DBC open and bind share one transaction when they fit (measured: 1,119 bytes for a two-segment curve; eight segments need two transactions of 1,194 and 517 bytes; sixteen do not fit the open alone) and are split otherwise, so a cross is never left with a pool and no bound mint when it can be avoided.
6. **External programs** (DAMM v2, DLMM, DBC, Raydium, and in ADR-0701 the Meteora programs) must exist on the cluster: 409 `EXTERNAL_PROGRAM_MISSING`.

## Consequences

`settle-tx.ts` responses gain `release` and `bytes`, and the transaction a compute-budget instruction in front; its tests decode past it. `services/api` depends on the adapters (already) and loads them on first use.

## Evidence

`services/api/test/settle-open-tx.test.ts` (26), `services/api/test/settle-tx.test.ts` (4), `packages/adapters/test/checks.test.ts` (7). Every built transaction is decoded back to instructions and its discriminator, signers and, where it matters, accounts checked.

## Not covered

No transaction was run against `cross_settle`: the new build is not deployed and LiteSVM does not run here. The gate was tested on fabricated ProgramData and, through `GET /v1/programs`, on the program on devnet (ADR-0600), not on the extended `cross_settle` binary. `open_dbc_pool` with `locked: false` uses the new argument layout, which is known only from the clients regenerated for W2D-D3. Preconditions the routes cannot read from an account (a gated mint's Token Badge for the migration, DAMM v2's own limits on fees) are left to the program.
