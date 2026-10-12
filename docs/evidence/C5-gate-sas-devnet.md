# Devnet proof — cross_gate identity gating with a real SAS attestation (C5)

Run: 2026-10-12T02:37:24.204Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/gate-sas-proof.ts` (`dp:gate`). Every transaction is a real devnet transaction; expected refusals are simulated against the deployed program, so no failed transaction is billed or recorded.
SAS program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` · cross_gate `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr` · cross_core `F5k8…` (see the cross address below)
Roles: one throwaway issuer/gate-admin key funded from the devnet promiser key, and four throwaway user wallets (alice attested, bob never attested, carol attested with a short expiry, dave attested then closed).

Not covered: the issuer is a throwaway key, so this proves the mechanism and not any real KYC provider (HUMAN H2: choosing which SAS issuers to trust). Merkle-allowlist passes and the hook/Token ACL gating of transfers are proved elsewhere (`token-acl-proof.ts`, `tests/core/test/sas.test.ts`).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| sas-present | the Solana Attestation Service program is deployed and executable on devnet at its published address | PASS | — | owner BPFLoaderUpgradeab1e11111111111111111111111 |
| credential | SAS credential created by the issuer | PASS | [3PfYJ893…](https://explorer.solana.com/tx/3PfYJ893Hf6pdUrz2sbEMHsoFkcrjxpGvy4NVU9sj54pFcb5BR4eFkSMbRcEV5XP42eRDEouZK78N8FCymkw1BBb?cluster=devnet) | credential C3ppTyu9eHAHTDh6aCnu441hCCo19Z4ohfLffNvYb6rk |
| schema | SAS schema created under the credential | PASS | [4kbe3xaY…](https://explorer.solana.com/tx/4kbe3xaYHXqnSnivVjgYpDKqugbpm5hSpEqfub18WCHNcmaXjaWbQ85VzxvVeptCgCBPqJDYMbzDSk97PnviK684?cluster=devnet) | schema SzM74dd9hUAZU1aSKwcwVDU5snFkjuGVWXrSjpqtEWC |
| gate | cross_gate config created for the mint and bound to the SAS credential and schema | PASS | [2WPZH6wY…](https://explorer.solana.com/tx/2WPZH6wY3dAgX33sgjz5o4FRsGxAwv1vsjDjHZswG3ep1Y3nAf5y2HtvfgUkanxEHkFdykRzURvgB8RXrhFt5MhT?cluster=devnet) | gate mint EKqSCpMy8UPMtAUokv4gMorCHppGiSz2gcqRzcCzsX6R, config DT9haDC6xU9nzLJbu15CPARxjSSnQUsB4H3Kj9Cv7crx |
| attestation | alice's SAS attestation exists on devnet, owned by the SAS program | PASS | [4ZcYxT73…](https://explorer.solana.com/tx/4ZcYxT73SDciFeYj5TB3F9i4Ur9NAmQeWn5i363xRfggR2av8Hc7PXrKAnvtUEDfm5KR9nBstMK1AKazP1g1Evd4?cluster=devnet) | attestation AGw4WYR9DMgGqeFEX6XMQ76aHqJnqWDJz4NBHobR1asY |
| claim-attested | an attested wallet claims a gate pass | PASS | [4PLs1z5H…](https://explorer.solana.com/tx/4PLs1z5HDHCUvcGMk1DVwqRKUKVbkxFmAAGke2CVE9Exc1UhkFft5uxyfRktdV3SNaW3UHfZsPk9GP1ftFVDXVhN?cluster=devnet) | pass 8rgmRnhtwG8nLMtvnKzTFwwPcLMg2ffS1Bd8XuCozJWp |
| refuse-unattested | a wallet with no attestation cannot claim a pass | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:277. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| refuse-borrowed | bob cannot claim with alice's attestation | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:726. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| claim-expiring | a wallet with a not-yet-expired attestation claims a pass | PASS | [B4h58o3A…](https://explorer.solana.com/tx/B4h58o3Ac5e9B5SHeDEZJnugRxammdygtEGLMzSpXBEi64tD7KyRiPhoPNMTFa5Trck5bguDVyazGxJ7yCbAeQs?cluster=devnet) | expiry 1791772632 |
| revoke-too-early | nobody can revoke a pass while its attestation is still valid | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:304. Error Code: AttestationStillValid. Error Number: 6014. Error Message: Attestation is still valid. |
| attestation-closed | the issuer closes the attestation at SAS | PASS | [Viiz1vNg…](https://explorer.solana.com/tx/Viiz1vNgkVvetLuDJP2cYTPDGGSCYBuea2soQ2CdY9EZwNmPBfS7dnJnytNBdAseBsHtYwPzkSJNari8Voh7aS3?cluster=devnet) | attestation BkVj9KQvUtiAqu9oojhGnfB2Y5FkxJWricEWmFwLus3A |
| revoke-closed | any wallet then revokes the pass | PASS | [2Rxxcq3a…](https://explorer.solana.com/tx/2Rxxcq3aQxroXH3wF2i8PFdxW1mR5yHiA42sb8Lhi1mPS29E2onVBiXgGXBvUgUXH3Q4jQRNiN7NbvLm2Pm5551W?cluster=devnet) | pass account closed |
| gated-cross | a cross_core cross is created bound to the gate mint | PASS | [4WxBtBgb…](https://explorer.solana.com/tx/4WxBtBgbGRGTz2QpfRjdpHqZrERoruu3LcXNLmaPymW91RBei7CAsHFa8CqDEcKKNUDtM2Gse4p1pzgawHbRkHi3?cluster=devnet) | cross H5CEbW6qTMYm525BnKk46RLXDASmhVswTauiM9fXBkUu |
| gated-bid-allowed | the attested wallet places an order in the gated cross | PASS | [8hrhkPcY…](https://explorer.solana.com/tx/8hrhkPcYbgFog9uEkLceiJZvHVMAM3WzjerSkz5ekD7HxHhQvd4ApYdQHhqKGWkSZbx6RGDchc1qxsv1fhjdr2p?cluster=devnet) | order account exists |
| gated-bid-refused | a wallet without a pass is refused with NotEligible | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross. |
| gated-bid-revoked-refused | dave, whose attestation was closed and pass revoked, is refused too | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross. |
| gated-clear | the gated cross clears with the attested wallet as the only buyer | PASS | [5K3XXG59…](https://explorer.solana.com/tx/5K3XXG59Jp2Jy12shB2bSAZDLzvynQXEj52rhxkD3MFbbqdJ84WQFAKPRqyFawWkcd4rn4aZwJXa4VDkSHUurkCv?cluster=devnet) | P* 1000000, matched 500000000 |
| gated-claim | the attested wallet receives its fill | PASS | [2Db5vVtX…](https://explorer.solana.com/tx/2Db5vVtXFfMYxHGtRpozrWJUL8vnCEJM67cw7LGEcZsiPYew2DuaFBztjoS87kCNuMewgWbEbPjdZtwkqfnLJte3?cluster=devnet) | alice holds 500000000 base atoms |
| gated-finalize | the gated cross finalises | PASS | [4NTw7yV5…](https://explorer.solana.com/tx/4NTw7yV5t7E2Z2bnjK8ReM4vz5fBVYDZc6RJ1JiYKTKBuqtgqRrvMQxCNSoW2fEotBsbjjK4tPWHjiQhDejt5Hij?cluster=devnet) | state Finalized |
| revoke-expired | after the expiry passes, any wallet revokes carol's pass | PASS | [8Gb3Ydep…](https://explorer.solana.com/tx/8Gb3YdepYAEKZLPcruTY8Z5TUkMoWtz1mhxFnT1unG2aTJ4drv4B7S858QseWv8Jo2cH8GSjTkqpMAAygFK2ev3?cluster=devnet) | expiry 1791772632 |
| refuse-expired | an expired attestation can no longer claim a pass | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:277. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 54970760 lamports returned |
