# W3D-X3: MetaDAO settlement adapter (`seed_futarchy_dao` in `cross_settle`), proved on LiteSVM

Status 2026-10-14: **instruction, client and tests built; proved on LiteSVM against the real mainnet `futarchy` v0.6 and Squads v4 binaries; not deployed (H27, batch 2).** Not audited. ADR-0657. Row X3.

## What was found first

`FEATURE_STATUS.md` said "no MetaDAO program on devnet was found to build against". It is there: `solana program show` on 2026-10-14 answers for `futarchy` (`FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq`), `conditional_vault` (`VLTX1ishMBbcX3rdBWGssxawAo1Q2X2qxYFYqiGodVg`), the v6 launchpad (`MooNyh4CBUYEKyXVnjGYQ8mEiJDpGvJMdvrZx1iGeHV`) and the v7 launchpad (`moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM`) on both devnet and mainnet; the v8 launchpad and the mint governor are on mainnet only. The IDL published on chain for `futarchy` is v0.6.1, the version in `research/repos/programs`.

## What was built

`seed_futarchy_dao(params, base_amount, quote_amount)` in `cross_settle`: after a cross clears at P*, the creator opens a MetaDAO DAO whose spot pool starts at P* and puts the opening liquidity into it, in one instruction with two calls into `futarchy` (`initialize_dao`, `provide_liquidity`). The adapter pins the first field of MetaDAO's parameters (`twap_initial_observation`) to `floor(P* x 10^12 / price_scale)` and requires the deposits to price the base at P* within one quote atom. It serves crosses whose two tokens are legacy SPL tokens (MetaDAO accepts nothing else) and refuses the rest with `FutarchyNeedsLegacyTokens`. It is also venue 3 of a graduation vote (ADR-0656). `cross_settle` grows from 731,888 to 758,328 bytes with it and the graduation gate; one event (`FutarchyDaoSeeded`) and one error were added.

## Tests

- `tests/core/test/futarchy.test.ts`: **4 passed**, real `futarchy.so` and `squads_v4.so` in LiteSVM, legacy-token mints: the DAO is created, its pool holds exactly the creator's two deposits and its price is P* to within a quote atom; a starting price one unit off in either direction, deposits two atoms off the ratio in either direction and a non-creator are refused; a Token-2022 cross is refused with the clear error; on a governed cross the adapter needs an outcome that names MetaDAO (venue 3), refuses one that names DAMM v2, and accepts the other.
- Unit tests in `cross_settle` (3): the discriminators equal Anchor's, the fixed-point price (1.3 quote per base is 1,300,000,000,000; 1/3 floors), the pinned field is the first 16 bytes.
- Mutation checks: pin removed -> 1 test fails; deposit ratio removed -> 1; creator check removed -> 1; legacy-token check removed -> 1; the governed venue number changed to DAMM v2's -> 1; MetaDAO price scale changed by a factor of ten -> 2.
- The DAO is created through MetaDAO's own `initialize_dao` and Squads' `multisig_create_v2` with their real checks (the Squads treasury must equal the program config's, found by the first failing run).

## Not covered

Devnet; the whole of MetaDAO's decision markets after the DAO exists (proposals, conditional vaults, the TWAP) because the adapter ends where MetaDAO begins; a Token-2022 cross (refused by MetaDAO itself); MetaDAO's launchpad programs (a different product: a raise, not a market opening); an audit. MetaDAO's code is BSL 1.1: the adapter calls the deployed program and copies none of it.

## FEATURE_STATUS row wanted

`| X3 MetaDAO adapter | PARTIAL | `cross_settle::seed_futarchy_dao` opens a MetaDAO futarchy DAO whose spot pool starts at P*, pinning the DAO's starting price and the deposit ratio to the cross's clearing price; MetaDAO's `futarchy` v0.6 and Squads v4 exist on devnet; 4 LiteSVM tests against the real binaries (`W3D-X3.md`, ADR-0657) | Legacy SPL tokens only (MetaDAO accepts no Token-2022); not deployed (H27, batch 2); no adapters builder or console step; MetaDAO's launchpad is not integrated; not audited |`

## What the app layers must add

`packages/adapters`: `buildSeedFutarchyDao` (accounts: the DAO PDA `["dao", creator, nonce]`, the Squads multisig, vault and spending-limit PDAs from `@sqds/multisig`, Squads' program config and its treasury read from the config account, the DAO's AMM vaults, the creator's position PDA `["amm_position", dao, creator]`, MetaDAO's event authority; the test's `buildSeed` is the reference) and the Borsh encoding of MetaDAO's `InitializeDaoParams`. Issuer console: the venue, its legacy-token precondition, and MetaDAO's decision-market settings. Diagnose: add `FutarchyNeedsLegacyTokens`.
