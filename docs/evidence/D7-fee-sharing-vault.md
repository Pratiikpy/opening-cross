# D7: Meteora Dynamic Fee Sharing vault

Date: 2026-10-13. Code: `packages/adapters/src/feeshare.ts`. Test: `tests/core/test/feeshare.test.ts`. Decision: ADR-0024.

Environment: LiteSVM with the real `dynamic_fee_sharing.so` (`tests/fixtures`, Meteora's deployed program), quote mint on Token-2022. Run in `tests/core`: `node node_modules/vitest/vitest.mjs run test/feeshare.test.ts`. Result: **2 passed**.

| Check | Result |
|---|---|
| Vault created for three recipients with weights 6000, 3000, 1000 | created |
| A third party funds 1,000,000,000 quote atoms; funder's balance falls by exactly that | 9,000,000,000 left of 10,000,000,000 |
| Each recipient claims: 600,000,000, 300,000,000 and 100,000,000 received | equal |
| A second funding of 500,000,000 and a second claim by the first recipient: 300,000,000 more | 900,000,000 in total |
| A wallet that is not a recipient cannot claim; a recipient cannot claim another's index; neither balance moves | refused |
| Builder refuses zero recipients, six recipients and a repeated recipient | throws |

## NOT covered

- Devnet: no transaction (no SOL).
- The DAMM v2 bridge (`fundByClaimDammV2Fee`): needs the position NFT account owned by the vault; not built or run.
- Vault creation with the keypair variant, Token-2022 transfer-fee mints and a vault funded from a DBC pool's fee claim.
