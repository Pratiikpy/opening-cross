# Devnet proof: the gate user path, from refusal with a diagnostic to a pass, a bid and a fill (W3, G6, G4)

Run: 2026-10-13T09:54:03.090Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/gate-live-proof.ts` (`dp:gate-live`). Every transaction is a real devnet transaction; expected refusals are simulated against the deployed program, so no failed transaction is billed or recorded.
The gate has two routes at once: a Merkle allowlist (alice) and a SAS requirement issued by the devnet test attester (bob). Carol is on neither.
The API code under test is `services/api/src/routes/gate.ts`, run in-process against devnet; the attester is `services/identity-attester`, started from key files through its environment variables. The attester is a **devnet test attester: it verifies that a wallet signed a challenge, nothing about identity.** Throwaway keys only; the proof writes them under the git-ignored `.keys/`.

Not covered: the HTTP mounting in the live API process (the coordinator wires `registerGate` into `server.ts`); the Postgres allowlist store (this run uses an in-memory store); a real KYC or accredited-investor provider (HUMAN_TASKS HI2, HG2); browser wallet signing (the wallet here is a local key).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| attester-config | the attester loads its key and challenge secret from files named by environment variables | PASS | — | attester 72BncPhZ3qxAbZ8CYpX43gDSbbkFVZgSiZRXfu8hwM5q; key files under .keys/ (git-ignored), not printed |
| attester-init | the attester creates its SAS credential and schema with the Solana Attestation Service's own instructions | PASS | [2MkQ9qQQ…](https://explorer.solana.com/tx/2MkQ9qQQKRUPvHsnDi9mmonDg6qYc4L3QDtdaDxAFiXhjNPXzCE7BgavFjfS79sQn43AteBrkjgt5aPuTCC2uvbP?cluster=devnet) | credential QAGD3b9LDsSWRWp3NDXCsQNs1rpMKndLfAWkZTGDHJU, schema 3y6KrXPAjw7FYz1RHYWfxiJ1xqymgwoJEfAGWqpujNBT |
| attester-label | the attester states that it verifies no identity | PASS | — | label "devnet test attester: no real identity verification"; not checked: who holds the wallet, residence or nationality, accredited-investor status, sanctions screening |
| gate | a cross_gate config holds both an allowlist root and the attester's SAS requirement | PASS | [27wg2RPT…](https://explorer.solana.com/tx/27wg2RPTWWpthTc9EW7GvhU1Rv2666M3jS1QB1XhzHnxcMTGUmko1AceEnUUHXF7DT97rHKvS1HrgPQ5m6WYkj1P?cluster=devnet) | gate mint FCibHzrH2tGntPtQ2p3MRpEobZhjwACVAYmVT5Mh2pMg, root 023be355be7598d904bf7e1b35aa36bd5e7b53a7ec45e3f199abd41c5af4c978 |
| gated-cross | a cross is created bound to the gate mint | PASS | [5wLXvkuz…](https://explorer.solana.com/tx/5wLXvkuzcUKBSzYBfEYvTirwhYihVWpgskdniHmYkFyQtQNsNsMcrKbnZNprM8oAeF9RxmFWtt32RJdD6nxQU1Kd?cluster=devnet) | cross Cs9zGJVE3vbZLwzhXcdUbUQffje3ufzjtkw6iddLCLid |
| discover | GET /v1/gates finds the gate from the cross and reports both routes | PASS | — | ["allowlist","attestation","authority"] |
| diag-alice-unpublished | alice is on the allowlist but the issuer has not published it: the diagnostic says no proof can be built yet | PASS | — | ALLOWLIST_NOT_PUBLISHED, NO_ATTESTATION |
| diag-bob-no-attestation | bob has no attestation: the diagnostic names the credential and the nonce that would satisfy it | PASS | — | Obtain an attestation with nonce 6aZuiZAhEWypXvBkccL8Rp3oCJBo29k9p2T5bUF9KUmg from credential QAGD3b9LDsSWRWp3NDXCsQNs1rpMKndLfAWkZTGDHJU (schema 3y6KrXPAjw7FYz1RHYWfxiJ1xqymgwoJEfAGWqpujNBT). Only the credential holder can issue it. |
| refuse-carol | a wallet without a pass is refused by the program with NotEligible, and the API names why on both routes | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross.; diagnostic: ALLOWLIST_NOT_PUBLISHED, NO_ATTESTATION |
| claim-refused-with-reasons | asking for a claim transaction when there is nothing to claim answers 422 with the same reasons and no transaction | PASS | — | HTTP 422: this wallet cannot claim a pass for the gate right now |
| publish-wrong-list | a list that does not hash to the root on chain is not accepted | PASS | — | HTTP 409: this list does not hash to the allowlist root on chain, so it was not published |
| publish-list | the list whose root is on chain is published | PASS | — | HTTP 200, root 023be355be7598d904bf7e1b35aa36bd5e7b53a7ec45e3f199abd41c5af4c978 |
| diag-alice-claimable | alice is now told she can claim | PASS | — | CLAIMABLE_BY_ALLOWLIST, NO_ATTESTATION |
| diag-carol-not-listed | carol, not on the published list, is told so, and that only the issuer can change it | PASS | — | NOT_ON_ALLOWLIST, NO_ATTESTATION |
| claim-allowlist | alice signs the transaction the API built and her pass exists on chain (claim_pass_merkle) | PASS | [25ptnVjM…](https://explorer.solana.com/tx/25ptnVjMCXSDGSSechnZN8W8xLiPq8C7HkUVjFFkjj4uWQ6YgaVeUKzyk2uT32GeX5XjiGgyB1z4umY62xjmjtTf?cluster=devnet) | pass 2NiAqE8u1mhS9fyjZ7wzNMXN3HNpqApMSzmDRGXRxqrm, proof length 0 |
| attester-refuses-forgery | the attester refuses a signature that is not the wallet's | PASS | — | HTTP 403: the challenge was refused: bad signature. Ask for a new one. |
| attest | after bob signs the challenge the attester writes a SAS attestation for his wallet | PASS | [5YFC2wUV…](https://explorer.solana.com/tx/5YFC2wUVnbPRnza88bGMDabxBj7dttRD599SRwjCToUQqNcfJmqpdXVwEkHKqh67R8bdVG4itgY8cRvPu7zaSin1?cluster=devnet) | attestation HXuc23C4vA2Yhtr8RmMwou2eheXApMUR5siNGKwb2XRn, expires 1791892230, label "devnet test attester: no real identity verification" |
| diag-bob-claimable | bob is now told he can claim with his attestation | PASS | — | NOT_ON_ALLOWLIST, CLAIMABLE_BY_ATTESTATION |
| claim-attestation | bob signs the transaction the API built and his pass exists on chain (claim_pass) | PASS | [4AzX3uZA…](https://explorer.solana.com/tx/4AzX3uZAzzFE3gpkfegT2mE3Z9Say3rrfVsEtYG5rhhDT2X9WLsz24Jx8ht9X7E22fCGGbTNSpVz1oH1H1ab9wiX?cluster=devnet) | pass 29AURFNRpx5tD6nh35VcYEAZus9qyjMmuoBeL5TpqDvq |
| claim-twice | a second claim for the same wallet answers 409 and no transaction | PASS | — | HTTP 409: this wallet already holds a pass for the gate |
| bid-alice | alice (allowlist pass) places an order in the gated cross | PASS | [3RyMxkUL…](https://explorer.solana.com/tx/3RyMxkULt8YyFzouQ2rZfacaqRxDdiwSJN6xa3LjLKYNjM9yGE1iZstKTEhtzyZ8ZQCr4SiyPLG95793heeZms4B?cluster=devnet) | order account exists |
| bid-bob | bob (attestation pass) places an order in the gated cross | PASS | [2fLUpz9N…](https://explorer.solana.com/tx/2fLUpz9NcUzhdj87RpcWwuLqeR1YEJJ4S1HhaFTGjEzb4jJ6cZz1RWBGnmTKPaApCExQhtw1VpRRyWH5xpaWSEGp?cluster=devnet) | order account exists |
| bid-carol-refused | carol is still refused after the others claimed | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:455. Error Code: NotEligible. Error Number: 6012. Error Message: Owner is not eligible for this cross. |
| diag-after | the diagnostic now reports alice and bob eligible | PASS | — | alice HAS_PASS,PASS_BACKING_LAPSED; bob HAS_PASS |
| clear | the gated cross clears with the two pass holders as its only buyers | PASS | [4PNyD7Bx…](https://explorer.solana.com/tx/4PNyD7Bx6zsbCfyQrRkFWY3Kn6hhigbMvj4NbK7C457HcvDu9MBBAsYWNbVRAfo5ZEJogxzchL9KhqzEppm1Xdsw?cluster=devnet) | P* 1000000, matched 1000000000 |
| fill-alice | alice receives a fill, read from the chain | PASS | [2Y5ojYmK…](https://explorer.solana.com/tx/2Y5ojYmKZUGyQnpzabXyqXz4tisUnSuVs5VdWtkNNmv6ik49CEaTVNCvRgXE4sGMdnWbSiaMm8NVTbGfNbXk84PU?cluster=devnet) | alice holds 500000000 base atoms |
| fill-bob | bob receives a fill, read from the chain | PASS | [29TPQX9t…](https://explorer.solana.com/tx/29TPQX9taYr1wudVaBAGPKNV4gA1hW1LrcEXqkxVPx3dW3nkkvFfZUiDASthCQ52K34NzCrtykgdQDgVr9GaKiVi?cluster=devnet) | bob holds 500000000 base atoms |
| fill-carol-none | carol, who could not bid, holds none of the new token | PASS | — | carol holds 0 base atoms |
| finalize | the gated cross finalises | PASS | [2Uzr3maR…](https://explorer.solana.com/tx/2Uzr3maRKo9WD39iUYhAd7mXnzrc11e1PNe6p3gUgwpepeTyvmiGDWrH72Jtk5T4JPqtrgXgHx5Dy8pz7DG9NWWt?cluster=devnet) | state Finalized |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 193828120 lamports returned |
