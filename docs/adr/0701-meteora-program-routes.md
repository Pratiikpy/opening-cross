# ADR-0701: Alpha Vault, Met Lock and Dynamic Fee Sharing routes, and why the DBC fee bridges are not built

Status: accepted (2026-10-14). Builds on ADR-0483, ADR-0484, ADR-0024, ADR-0700.

## Decision

`routes/meteora-tx.ts` routes the builders of `@opening-cross/adapters` that wrap Meteora's three programs around a cross's market: the Alpha Vault (init, deposit, fill, claim, withdraw remaining, and a read), Met Lock (create, claim, and a read) and Dynamic Fee Sharing (create, fund, claim, hand the DAMM v2 position to the vault, pull the position's fees in, and a read). Alpha Vault routes are keyed by the cross whose pool the vault binds: DAMM v2 records only the vault derived from the account that created the pool, which is the cross's creator.

The accounts are decoded from the programs' IDLs (`idls/alpha_vault.json`, `idls/met_lock.json`, the fee-sharing SDK's IDL) with the offsets the IDLs give. Because a wrong offset would build a plausible and wrong transaction, they were checked against the chain: all 8 Alpha Vaults and 8 Met Lock escrows read from devnet had their address re-derived from the fields decoded (the vault from base and pool, the escrow from base and mint), and the escrow's token-program flag matched the mint's owner in every case; the vault mode byte was 0 for the three pro-rata and 1 for the five first-come vaults read; the fee-sharing vault of `D7-fee-sharing-vault-devnet.md` decoded to the totals in that document (10,000 shares, 492,631 funded, 246,315 claimed by each). The real accounts are fixtures (`services/api/test/fixtures/meteora-devnet.json`).

Refusals that protect money the program would not: `fee-share-transfer-position` is one way, so it is refused unless the vault exists, splits this pool's quote token and the creator holds the position; `metlock-create` is refused for a mint with an active transfer hook, because the builder passes no hook accounts and the tokens could end up in an escrow nobody can claim from; every route that moves a token checks the balance and the account first and names the account to create.

## The DBC creator and partner fee bridges are not built

Meteora's fee-sharing program can claim a DBC pool's trading fees into a vault (`fundByClaimDbcCreatorTradingFee2`, `fundByClaimDbcPartnerTradingFee2`), but only when the vault is the pool's creator, or the config's fee claimer (the SDK refuses with `InvalidCreator` / `InvalidFeeClaimer` otherwise; the program signs for the vault).

- **Partner:** `open_pool` sets the config's fee claimer to the settler PDA, and a config's fee claimer does not change. The partner's fees already reach the fee recipient through `claim-partner-fee` (ADR-0480). A vault cannot be the partner of a pool this protocol opens.
- **Creator:** the pool's creator is the issuer's wallet (it signs `open_pool`). It can be handed to a vault with DBC's `transfer_pool_creator`, but DBC's migration mints the creator's position NFT to `virtual_pool.creator` (`migrate_damm_v2_initialize_pool`), so the creator's permanently locked share and its vesting share would be owned by an account that can sign nothing. With the locked design (ADR-0482) that is 70% of the migration liquidity.

Building the bridge would offer a button that strands the issuer's liquidity, so it is not built. After migration the fees take the route that is built: the DAMM v2 position to the vault (`fee-share-transfer-position`) and `fee-share-fund-from-damm`. The row stays PARTIAL on this account.

## Evidence

`services/api/test/meteora-tx.test.ts` (23): the decoders on the real accounts, every route in every state it has (including the refusals above), each transaction decoded. Against the real programs on devnet, by simulation of the unsigned transactions the routes built (`sigVerify: false`): `metlock-claim` for a funded recipient of a Token-2022 escrow (Met Lock program `success`, 29,714 compute units), and `fee-share-claim` for the fee vault of the D7 proof (Dynamic Fee Sharing and the associated token program `success`). The other escrows tried failed only because their recipients hold no lamports for the fee. `docs/evidence/W3E-markets-keeper-neutrality.md`.

## Not covered

Alpha Vault routes were not simulated or sent anywhere (no devnet vault belongs to a cross), and `alpha-vault-init` / `-fill` depend on a pool bound at creation by `seed-damm-v2 { alphaVault: true }`, which needs the extended `cross_settle`. The DLMM fill (`fill_dlmm`) is not built. `fee-share-fund-from-damm` and `fee-share-transfer-position` were proved on LiteSVM in D7 and not re-run. A vault's recipients' claimable amounts are not computed (the accumulator's scale was not verified); the read shows shares and what each has claimed.
