# Devnet proof — cross_gate identity gating with a real SAS attestation (C5)

Run: 2026-10-12T01:18:19.611Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/gate-sas-proof.ts` (`dp:gate`). Every transaction is a real devnet transaction; expected refusals are simulated against the deployed program, so no failed transaction is billed or recorded.
SAS program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` · cross_gate `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr` · cross_core `F5k8…` (see the cross address below)
Roles: one throwaway issuer/gate-admin key funded from the devnet promiser key, and four throwaway user wallets (alice attested, bob never attested, carol attested with a short expiry, dave attested then closed).

Not covered: the issuer is a throwaway key, so this proves the mechanism and not any real KYC provider (HUMAN H2: choosing which SAS issuers to trust). Merkle-allowlist passes and the hook/Token ACL gating of transfers are proved elsewhere (`token-acl-proof.ts`, `tests/core/test/sas.test.ts`).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| sas-present | the Solana Attestation Service program is deployed and executable on devnet at its published address | PASS | — | owner BPFLoaderUpgradeab1e11111111111111111111111 |
| credential | SAS credential created by the issuer | PASS | [5PrUKutM…](https://explorer.solana.com/tx/5PrUKutMGqH1jE9WexkhvUCJizywvz7DRiDwW3WwVFrMcmrMCA4KiKP73zRcW9vh2Dv3R937BWpqNmGY4syX55uo?cluster=devnet) | credential 2eemzNKLKcoXdrdrCbjRfeuHCZQL1hWBSgeYyZ9ozogd |
| schema | SAS schema created under the credential | PASS | [5HauXv2R…](https://explorer.solana.com/tx/5HauXv2RW17iRgD3y3L7F8qxer2yWbQtFRYBevBQ9S4qwZExPjWJE85MAvRT86vGpH47duk1WnrNfFut9U59FWqW?cluster=devnet) | schema 6cMDreuucSoCqw3k3S694hNH8QznCKVD3yWB6ZnowZYi |
| gate | cross_gate config created for the mint and bound to the SAS credential and schema | PASS | [26n8Nn3s…](https://explorer.solana.com/tx/26n8Nn3s1Gq1HA3SBXaobhwzgZy2hbeMRtnHwAUqr6x2GjAUgZ42pkT7Y1w9bezdcDmzFoiH7jRWNAy1uSj2z74G?cluster=devnet) | gate mint 8zVtk1vE21KFXkDZGwwiMEGyfud19efR3SxTFjoiJ5P9, config 2d8SynLrBUALPqcjjDHdJVBNArSg9awG9RDACexAMC8j |
| attestation | alice's SAS attestation exists on devnet, owned by the SAS program | PASS | [2A9PYTEp…](https://explorer.solana.com/tx/2A9PYTEpc1mjtZd4GdGhrHz6CJyKqWmyoyg6VfHYVD3C9t3ZFDSsRqFEsBXQkUDcwWaN61yyuLaffe4TG5kyzkAf?cluster=devnet) | attestation DZYhEdVcs5jG5erx48Q4QU9ABgA3ahe8EfVGVZhnbU71 |
| claim-attested | an attested wallet claims a gate pass | PASS | [4JreU4BB…](https://explorer.solana.com/tx/4JreU4BB6ih2B4VoNZqj5rwgD51X9LfVUtxybTN2ha485FimpFkyD2kvUGkKggg6CxLzwstJHKJgidn56BPnm6JG?cluster=devnet) | pass 3LNZEKLtisA3Xk57rM3xzTErC8f1XFStfKJgfFPFVNfQ |
| refuse-unattested | a wallet with no attestation cannot claim a pass | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:277. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| refuse-borrowed | bob cannot claim with alice's attestation | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:726. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| claim-expiring | a wallet with a not-yet-expired attestation claims a pass | PASS | [vfcgdzt6…](https://explorer.solana.com/tx/vfcgdzt6Lxxur68GMVc14kkcfbpjdZCyVGAj22wQp1uhpEaTgej6E1tGr3DQtcVgo7ggtN5aW2npf5Euz2SiVQB?cluster=devnet) | expiry 1791767820 |
| revoke-too-early | nobody can revoke a pass while its attestation is still valid | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:304. Error Code: AttestationStillValid. Error Number: 6014. Error Message: Attestation is still valid. |
| attestation-closed | the issuer closes the attestation at SAS | PASS | [2ZEPP3S6…](https://explorer.solana.com/tx/2ZEPP3S6jmzhN2jphjPMS4E3C3TEYqkNBnwwYRCh1KUpLK8z8fvv6fXricuT3MqQV7MYMTctLmAAyREgR9LhLrDT?cluster=devnet) | attestation 8Mr2HKnpcp1nkEcBX13PqyhsB4ttbFGN1WJRjqjjMwFG |
| revoke-closed | any wallet then revokes the pass | PASS | [KdTCn8Bb…](https://explorer.solana.com/tx/KdTCn8Bb4DzxewrtA495eRw69E4MGXjGkfHEGHCbeszgSPJp1HHDhFz3mFA1vgCTx9Z2TCTjpzMiJ5toy842RJK?cluster=devnet) | pass account closed |
| gated-cross | a cross_core cross is created bound to the gate mint | PASS | [2mWY2UaK…](https://explorer.solana.com/tx/2mWY2UaKqyzvNu3AzfQPoQzfdMJLT7hshWZcwsFTVxqBAzUwwbGCmJsbVZs1fatJWExnM7kusuNK53cyude9ZTyF?cluster=devnet) | cross C9H3NiKL5YaZNyshPydA6FTzMQdGcRv7zHHf6X3Ba1wA |
| gated-bid-allowed | the attested wallet places an order in the gated cross | PASS | [3vaPAXRk…](https://explorer.solana.com/tx/3vaPAXRkyHU2ffSJTRxmRnmhkUze66vLC1V5KHAwDzsF2oqddCFRY72HMPihneaBdrFCEoFQnoPhRvwzzRDYfSf6?cluster=devnet) | order account exists |
| gated-bid-refused | a wallet without a pass is refused with NotEligible | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross. |
| gated-bid-revoked-refused | dave, whose attestation was closed and pass revoked, is refused too | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross. |
| gated-clear | the gated cross clears with the attested wallet as the only buyer | PASS | [5HgJKb3c…](https://explorer.solana.com/tx/5HgJKb3cqgTA1XHdy7QUFbqiJTQNXxeWBrTtGNPDbB8Nxywa48MoL55QTcXWnfcnnFPBdv57Nqzki7HifkVVPZ1V?cluster=devnet) | P* 1000000, matched 500000000 |
| gated-claim | the attested wallet receives its fill | PASS | [3rQRKHrq…](https://explorer.solana.com/tx/3rQRKHrqMxWo4k91w2MsZMK2BHa696vYNUtyAuXek4nrpFxtFe3S1AFpBJtccYqh6iqokDPJUkJq1omtKLP3ZD46?cluster=devnet) | alice holds 500000000 base atoms |
| gated-finalize | the gated cross finalises | PASS | [5Xt4eaqP…](https://explorer.solana.com/tx/5Xt4eaqPeueQ1Gu1gPbc1gHQvSzEX8BExv3hUDngvJimzrAM2DBHvsfXmPe25SMMmdHqwqbTh4C4UGG87qmY6gQR?cluster=devnet) | state Finalized |
| revoke-expired | after the expiry passes, any wallet revokes carol's pass | PASS | [2ahnRX1y…](https://explorer.solana.com/tx/2ahnRX1yqPAA9r7JkxJzfr1ohzG8B8EYqnwhnnTr7wTXfkjKv4xHNo3Qr88R4tWknzRYmVMT927NL9Ndhxc6jozf?cluster=devnet) | expiry 1791767820 |
| refuse-expired | an expired attestation can no longer claim a pass | PASS | — | Program log: AnchorError thrown in programs/cross_gate/src/lib.rs:277. Error Code: AttestationInvalid. Error Number: 6013. Error Message: Attestation is missing, foreign, expired or not for this wallet. |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 104970760 lamports returned |
