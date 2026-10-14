# ADR-0657: A MetaDAO settlement adapter, `seed_futarchy_dao` (X3)

Status: accepted (2026-10-14)

## Context

PRODUCT_FEATURES [X3]: "`metadao` / decision-market settlement adapter, so MetaDAO-style raises clear through the cross." ADR-0486 and `FEATURE_STATUS.md` recorded it as not built because "no MetaDAO program on devnet was found to build against". That was wrong: MetaDAO's `futarchy` (v0.6.1, `FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq`), its `conditional_vault` and the v6 and v7 launchpads are deployed on devnet and mainnet (checked with `solana program show` on both clusters, 2026-10-14); the v8 launchpad and the mint governor are on mainnet only. The IDL published on chain for the program is v0.6.1, the same as `research/repos/programs`. The fixture `tests/fixtures/futarchy.so` is the mainnet binary.

## Decision

A new `cross_settle` instruction, `seed_futarchy_dao`, in the family of `seed_damm_v2`, `open_dlmm_pair` and `seed_raydium_cpmm`: after a cross clears at P*, the creator opens a MetaDAO DAO whose spot pool starts at P* and puts the opening liquidity into it, in one instruction with two calls into `futarchy`:

1. `initialize_dao`. The parameters are the creator's (MetaDAO's decision-market settings are the DAO's own business: pass threshold, proposal length, TWAP bounds, team), passed through as the Borsh bytes MetaDAO expects, except for the first field, `twap_initial_observation`, which the adapter pins to `floor(P* x 10^12 / price_scale)`: MetaDAO's fixed-point price of one base atom in quote atoms (`PRICE_SCALE = 10^12` in `futarchy`). The DAO's decision markets therefore start from the price the cross printed.
2. `provide_liquidity` with the creator's two deposits, whose ratio must price the base at P* to within one quote atom (the same rule as the Raydium adapter); the creator owns the LP position. The first liquidity is minted as `quote x 10^9`, which the adapter passes as the minimum.

The adapter checks what only it can: the signer is the cross's creator, the cross cleared and its token exists, the mints are the cross's, the starting price and the deposits are P*. Everything else (Squads multisig and vault, the spending limit, the PDAs) is MetaDAO's and Squads' to validate.

## Limits, said plainly

- **Legacy tokens only.** MetaDAO's `initialize_dao` and `provide_liquidity` accept legacy SPL Token mints and a six-decimal quote (`Account<Mint>`, `Program<Token>`). This product's assets are mostly Token-2022 (pausable, scaled-UI, transfer-hook), so the adapter serves crosses whose two tokens are legacy tokens and refuses the others up front with `FutarchyNeedsLegacyTokens`, instead of letting MetaDAO fail on them.
- **A different trust model.** After seeding, the DAO's treasury and rules are MetaDAO's: a Squads multisig governed by decision markets. The cross decides the price; MetaDAO decides what happens next. Issuers choose it; nothing makes them.
- **Licence.** MetaDAO's programs are BSL 1.1: the adapter calls the deployed program at its address and copies none of its code (the instruction and account layouts are interface).
- It is also a venue a graduation vote can choose (`Venue::Futarchy = 3`, ADR-0656).

## Evidence

`tests/core/test/futarchy.test.ts` runs the real mainnet `futarchy` and Squads v4 binaries in LiteSVM: the DAO is created, the pool holds exactly the creator's deposits and its price is P* to within a quote atom; a starting price one unit off in either direction, deposits two atoms off the ratio in either direction and a non-creator are refused; a Token-2022 cross is refused with the clear error; on a governed cross the adapter needs an outcome that names MetaDAO.

## Consequences

- `cross_settle` grows by about 26 KB, one instruction (`seed_futarchy_dao`), one event, one error (`FutarchyNeedsLegacyTokens`, appended).
- The adapters package and the issuer console add the builder (accounts: Squads and MetaDAO PDAs, derived by `@sqds/multisig` and the seeds in the test helper) and the legacy-token precondition.
