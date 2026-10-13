# Devnet proof — DAMM v2 seeding at P* (A2)

Run: 2026-10-13T08:42:08.322Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/damm-proof.ts`
Programs: cross_settle `2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ`, cp-amm (DAMM v2) `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` — both executable on devnet (checked with getAccountInfo before the run)

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | fresh creator 37qipRy1t7woHmDqwMngt4et8c3J6XyLDR4HNT24LDzt funded 1.5 SOL from the promiser key | PASS | [43PvuGR3…](https://explorer.solana.com/tx/43PvuGR3eN1u1dkReXQZFTsYUfdfVunBMWYi8cZgyEV2PUti4hSfXa3o1gf2kNkuQ8F5vHcF4NTjoBYQnekkzDcj?cluster=devnet) | bidder D7gTQAAyeNqGk4UG9PjeHNpLboS1aySQAMSpxuccE5Pn, trader BLCmrwyzwW1RByuxsSeiK7hY7fxUMfk4JPMxnZ261hzg |
| cross-create | mint-mode launch cross created on the deployed cross_core; the cross PDA holds the base mint authority | PASS | [5ucUJeN6…](https://explorer.solana.com/tx/5ucUJeN6bzyQfA6xwv93fJDea8b24d5FojY2VDyBu8686gJhMh42WYKiHXJsZ2BaPyUF6eZv57uJUXEuTUMZyqB1?cluster=devnet) | cross BYAZwuKnRyCvgiDcFU2puKC2t6ELUc7hktB7XTJ8brfM, base EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV, quote 7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy |
| bid-0 | bid 1000 tokens at 1.6 escrowed | PASS | [2Gzeo2U2…](https://explorer.solana.com/tx/2Gzeo2U2R5RyZR1j95wiaaXKARSURty15vJGc5RdPgok8CekxzZ2ZuDoUBW8xy7S6mAMFCByRFeNNoXudQw3xKde?cluster=devnet) | bidder 37qipRy1t7woHmDqwMngt4et8c3J6XyLDR4HNT24LDzt |
| bid-1 | bid 1800 tokens at 1.3 escrowed | PASS | [3v7Ho4yF…](https://explorer.solana.com/tx/3v7Ho4yFEkJVTWuMDUgQgqNAQ1kyN3YxMRExwVuoFXySj2V6X9Q4AkPskeszsUWe7XXGhunp84LxXTrv2VCA2H42?cluster=devnet) | bidder D7gTQAAyeNqGk4UG9PjeHNpLboS1aySQAMSpxuccE5Pn |
| clear | on-chain clearing price and volume equal the independent reference | PASS | [3PR1mNHn…](https://explorer.solana.com/tx/3PR1mNHnFM9jhHTCfUFqDRC9K4AT9K6TUHPow56yVL2mGDs2P6LKKkeiQ1YBMhb4Yxp3dhrVXFWUQzLfCmt5STbW?cluster=devnet) | P* 1300000 (reference 1300000), matched 2800000000 (reference 2800000000) |
| claim-0 | claim minted the fill at P* and refunded the escrow above it | PASS | [3d9heZCY…](https://explorer.solana.com/tx/3d9heZCYwu2kKhSvoqMt7xtmup2UAXhFbtrxbvQVBx8rbYecaAkmiAaKKxpZjTCPpn9A81qT6wteBGxtJLTPDR9P?cluster=devnet) | fill 1000000000, refund 300000000 |
| claim-1 | claim minted the fill at P* and refunded the escrow above it | PASS | [5T6Ey1DC…](https://explorer.solana.com/tx/5T6Ey1DCekAsd9UjUF5VLomTFKyASRcNmm88TZkJ4Bdf6bihbSD3Jrw72cGKrpmRZznjwWEHuy16LFrj4Kknhb6r?cluster=devnet) | fill 1800000000, refund 0 |
| finalize | cross finalised on chain | PASS | [z8nvFvjM…](https://explorer.solana.com/tx/z8nvFvjMpyJ8QmAiumdJwzvbZnVvye8upicZZEuZ6tAkg516VPuTyQyBXc9pN5kgAPj8SnJzFMLrimwFsirSYxd?cluster=devnet) | state 3 |
| refuse-wrong-price | a pool whose start price is not P* is refused by cross_settle | PASS | — | tried 1400000 against P* 1300000: StartPriceNotClearingPrice |
| refuse-non-creator | a wallet that did not create the cross cannot seed its pool | PASS | — | trader BLCmrwyzwW1RByuxsSeiK7hY7fxUMfk4JPMxnZ261hzg: NotCreator |
| pool-price | the DAMM pool account holds exactly the sqrt price of P* | PASS | [iLT7s5Df…](https://explorer.solana.com/tx/iLT7s5DfAJKkhihE5eHf5yKdgpmZnUARhKi1z4ADKzF2kR3eoY4pk49yhWkw1qwwC8xe9MaeYz1P33Y1DoZd7X6?cluster=devnet) | pool 5fDuBQZnim5qF8gJHQebPfqS1eLSEhHxo6hurXsmP8AU sqrt_price 21032524265936792269 (expected 21032524265936792269); P* 1300000/1000000 |
| pool-mints | token A is the launch token and token B is the quote token | PASS | — | A EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV B 7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy |
| pool-reserves | the pool vaults hold the deposits (≥ 99.9% of both sides, never more than offered) | PASS | — | vault A 900000000 of 900000000, vault B 1170000000 of 1170000000; liquidity 18929271843208656258080824493 |
| position | the creator owns the liquidity position (the position NFT token account is owned by the creator and holds 1) | PASS | — | position G7HA6UxiVRht3HBoTr3FN3NkYcmgeqYW8SGSdDoMVsX5, nft account 98MpNCVUqPXJjj69VPaGmjxDzaHxtQSTNebmMoTc4N8u, owner 37qipRy1t7woHmDqwMngt4et8c3J6XyLDR4HNT24LDzt |
| swap-near-pstar | a real swap pays within 1.5% of P* (0.30% fee plus the price impact of 0.55% of depth) | PASS | [53j3qFpk…](https://explorer.solana.com/tx/53j3qFpkmqzmUpLz6gMork9nvsPjknKx57PzV1cAnXVsdoqMkyWcPJ9zxNEdK6xk8MTVQeSaUvRmvm4qCwRainKo?cluster=devnet) | 5000000 base in → 6444695 quote out; 6500000 at exactly P*; ratio 0.99149 |
| swap-model | the amount received matches an independent constant-product model within 0.05% | PASS | — | received 6444695, model 6444696.1 (gross 6464088.4, fee 30 bps), error 0.0000% |
| swap-pool-price | the pool price moved down to the modelled price after base was sold into it | PASS | — | sqrt price 1.140175425099138 → 1.133876113359538 (model 1.133876113359538) |
| cost | the whole run, including rent for the cross, mints and pool, fit inside the 2 SOL cap; the remainder went back to the promiser | PASS | — | creator spent -1.18665964 SOL, returned 1.34332732 SOL |
