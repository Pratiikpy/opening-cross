# ADR-0505: The treasury and cross_settle routes

Status: accepted (2026-10-14).

## Decision

One route per instruction: `POST /v1/treasuries/:address/tx/<action>` for the treasury (25 actions: the 20 new instructions and the first release's `spend`, `record-attested`, `record-lapse`, `trigger-liquidation` and `redeem`) and `POST /v1/tx/<name>` for cross_settle (the partner payouts and the greenshoe).

A route reads the treasury or cross and the token accounts it needs, makes the checks the program would make from chain state (an extension exists, the holder has the coins, the vote is open, the proposal passed, the cap, the attestation exists, the window is open), refuses with a `reason` that is stable and a sentence that says what to do, and returns the unsigned transaction with the facts a screen shows (the payout at NAV, what is claimable, the id a proposal will get). Where an instruction pays a wallet that may have no token account the transaction creates it first. Reads are `GET .../ext`, `/proposals`, `/proposals/:id`, `/positions/:owner`, `/grants`, `/rounds` and `/events`; proposals, grants and rounds are read from their accounts (the list is capped at 100), the history from the index.

`init-ext` mirrors `ExtParams::validate` and the clock check (`checkExtParams`), and separates what the program refuses (`severity: "refused"`) from what it accepts and would leave unusable (`"advice"`: an assignment gate with no counsel credential can never open, revenue rounds with no attester can never be paid). The two advice items are this work's own, not the program's.

Not routed: the instructions that open a venue (`open_dbc_pool_locked`, `seed_damm_v2_batched`, `open_dlmm_pair_batched`, `open_dlmm_pair_badged`, `seed_raydium_cpmm`). They take a pool design (curve, fee schedule, vesting) as their input and are built by the issuer's tooling with `@opening-cross/adapters`; an HTTP body for a curve design would be a second place to get it wrong. The settle routes load `@opening-cross/adapters` (which brings Meteora's SDK) on first use, not at start.

## Consequences

`services/api` now depends on `@opening-cross/adapters` and `services/indexer` on `@opening-cross/cross-settle-client` (workspace links). `pnpm-lock.yaml` was edited by hand to match; the next `pnpm install` confirms it.

## Evidence

`services/api/test/treasury-tx.test.ts` (12), `services/api/test/settle-tx.test.ts` (3), `tests/core/test/sdk-treasury-builders.test.ts` (10: the construction of `treasury-world.ts` against the builders, and the arithmetic against the figures of the Rust unit tests), `docs/evidence/W3A-builders-devnet.md` (the deployed treasury instructions against a live treasury).

Not run: the extension instructions against a program. They are not deployed, and the 45 treasury LiteSVM tests run the transcribed construction.
