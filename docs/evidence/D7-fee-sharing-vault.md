# D7: Meteora Dynamic Fee Sharing vault

Date: 2026-10-13. Code: `packages/adapters/src/feeshare.ts`. Test: `tests/core/test/feeshare.test.ts`. Decision: ADR-0024.

Environment: LiteSVM with the real `dynamic_fee_sharing.so` (`tests/fixtures`, Meteora's deployed program), quote mint on Token-2022. Run in `tests/core`: `node node_modules/vitest/vitest.mjs run test/feeshare.test.ts`. Result: **3 passed**.

| Check | Result |
|---|---|
| Vault created for three recipients with weights 6000, 3000, 1000 | created |
| A third party funds 1,000,000,000 quote atoms; funder's balance falls by exactly that | 9,000,000,000 left of 10,000,000,000 |
| Each recipient claims: 600,000,000, 300,000,000 and 100,000,000 received | equal |
| A second funding of 500,000,000 and a second claim by the first recipient: 300,000,000 more | 900,000,000 in total |
| A wallet that is not a recipient cannot claim; a recipient cannot claim another's index; neither balance moves | refused |
| Builder refuses zero recipients, six recipients and a repeated recipient | throws (a single recipient is refused as well since wave 5.1: the real program answers `ExceededUser`, ADR-0912) |

### DAMM v2 fees routed into the vault

A DAMM v2 pool opened at P* (1% fee). The issuer hands the position NFT's token account to the vault (`buildTransferDammPositionToFeeVault`, Token-2022 `SetAuthority`), a trader swaps 1,000,000,000 base in, and a vault recipient pulls the position's fees into the vault in one instruction (`buildFundFeeShareFromDammFees`: Meteora's `fund_by_claiming_fee` carrying cp-amm's `claim_position_fee`).

| Check | Result |
|---|---|
| The position NFT token account's owner is the vault after the hand-over | equal |
| The vault's token account held 0 before the pull and 7,999,999 quote atoms after | funded |
| The two 50/50 stakeholders then claim 3,999,999 each; together they take all but at most 2 atoms of what was pulled | equal |

## NOT covered

- Devnet: no transaction (no SOL).
- A DBC pool's creator or partner trading-fee bridge (`fundByClaimDbcCreatorTradingFee2`), and a pool that also collects token A fees.
- Vault creation with the keypair variant, Token-2022 transfer-fee mints and a vault funded from a DBC pool's fee claim.
