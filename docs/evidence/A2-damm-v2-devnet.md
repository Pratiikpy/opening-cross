# Devnet proof — DAMM v2 seeding at P* (A2)

Run: 2026-10-12T01:40:16.568Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/damm-proof.ts`
Programs: cross_settle `2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ`, cp-amm (DAMM v2) `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` — both executable on devnet (checked with getAccountInfo before the run)

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | fresh creator CaEb7ChaTN1XnXfDosxRzHp3Um48av3sYE3ifU3MiQJN funded 0.24 SOL from the promiser key | PASS | [dX4XbCk7…](https://explorer.solana.com/tx/dX4XbCk7M1Ms7cqpXZbu5BQ8qxLaZ95jFxxsTQ7wqmsvnCnauecmx4oKhaqGy9fDejc1G7RLez4ADw4sTS8nrsx?cluster=devnet) | bidder FELZL8cJcRCSfCez5jrzwcZeZMUccyUMzwESdWc1hskJ, trader BzJxaYH3wUR4WkKnJUTy7cuHZRpao6hRTzjVb91NfGJB |
| cross-create | mint-mode launch cross created on the deployed cross_core; the cross PDA holds the base mint authority | PASS | [R5uqztGX…](https://explorer.solana.com/tx/R5uqztGX4mhZCFuY1eRgeiZPijVfqQGFHEYjV4SRvrpsCmckRYMxLpnFdjMvnhSgxUaQhuCVCL9ZCg88kwAUFhv?cluster=devnet) | cross 3R8XaFKxXQ64kbN6Uq3gp4D1M51UsggqF6UHZ5uYYn6m, base 3bgVzNLJKnnwnVV4muYcoqs8oSGENHEWWKvyptNpGzox, quote GHTyXMu53X2uTvA33wXNwo9VhKFLLWHFaPHz28AQFF11 |
| bid-0 | bid 1000 tokens at 1.6 escrowed | PASS | [5JcrjKyo…](https://explorer.solana.com/tx/5JcrjKyozMS8zEbU8o7WThty2RgpuCkCDL3XqhZXgimG71GktKv8KSYpko7aX6eFQMBQyJ7zU7rqHgeK6Kwn2Qh5?cluster=devnet) | bidder CaEb7ChaTN1XnXfDosxRzHp3Um48av3sYE3ifU3MiQJN |
| bid-1 | bid 1800 tokens at 1.3 escrowed | PASS | [49sdi5WM…](https://explorer.solana.com/tx/49sdi5WMUjLYdhEDtALrRsUXw2Pcd3tMyLb6x3d9jXQJ9HY4EvWUt2kwMJH1kNgZfZD83qxwcjMb7js3haPJ7ZM3?cluster=devnet) | bidder FELZL8cJcRCSfCez5jrzwcZeZMUccyUMzwESdWc1hskJ |
| clear | on-chain clearing price and volume equal the independent reference | PASS | [me54WEtf…](https://explorer.solana.com/tx/me54WEtfCTdzrwfw9i1ejByKS9intozgrgc2fj43PK64tfVpQwmrCcMD6Y3ruXd1C9LPrcjQwVzaQeDKbFAKRvD?cluster=devnet) | P* 1300000 (reference 1300000), matched 2800000000 (reference 2800000000) |
| claim-0 | claim minted the fill at P* and refunded the escrow above it | PASS | [4zxmi7sN…](https://explorer.solana.com/tx/4zxmi7sNEi7dhmmWzwM2zwVw2tgDSvPkHukzh4u4mXSTBxwFtJF3oGop918RjuY6wsoegp97P92FYxEDbisw4QLg?cluster=devnet) | fill 1000000000, refund 300000000 |
| claim-1 | claim minted the fill at P* and refunded the escrow above it | PASS | [2ySiD27S…](https://explorer.solana.com/tx/2ySiD27SKCYw6crdkLR3V1TDkqYdWJMkPj286TgunmM9Tt6VsGBpittMC7EuFLDwsLpaGdC5twN1aKGF4aZBhoNn?cluster=devnet) | fill 1800000000, refund 0 |
| finalize | cross finalised on chain | PASS | [5pjAZFQ9…](https://explorer.solana.com/tx/5pjAZFQ9aVswkrYh6iasKoTtgFDBenSYwikavRBsTwb6xJRvFaNUYmgorzaQJZaZUEDhyGJN13dSQty7n8kE8SC2?cluster=devnet) | state 3 |
| refuse-wrong-price | a pool whose start price is not P* is refused by cross_settle | PASS | — | tried 1400000 against P* 1300000: StartPriceNotClearingPrice |
| refuse-non-creator | a wallet that did not create the cross cannot seed its pool | PASS | — | trader BzJxaYH3wUR4WkKnJUTy7cuHZRpao6hRTzjVb91NfGJB: NotCreator |
| pool-price | the DAMM pool account holds exactly the sqrt price of P* | PASS | [35i6AVE8…](https://explorer.solana.com/tx/35i6AVE8aN2ou7cezW9QASmtkdxWJZvt9wCXQyJG2sTG5AZHMKCfMso3UTiXc4CmUonUgeMerbPLw7dHYXiWNmvR?cluster=devnet) | pool 5T859r6E3ZUHSb6J5xTNQK9W8SGEN2TVCUGziNjqFGvu sqrt_price 21032524265936792269 (expected 21032524265936792269); P* 1300000/1000000 |
| pool-mints | token A is the launch token and token B is the quote token | PASS | — | A 3bgVzNLJKnnwnVV4muYcoqs8oSGENHEWWKvyptNpGzox B GHTyXMu53X2uTvA33wXNwo9VhKFLLWHFaPHz28AQFF11 |
| pool-reserves | the pool vaults hold the deposits (≥ 99.9% of both sides, never more than offered) | PASS | — | vault A 900000000 of 900000000, vault B 1170000000 of 1170000000; liquidity 18929271843208656258080824493 |
| position | the creator owns the liquidity position (the position NFT token account is owned by the creator and holds 1) | PASS | — | position bfJ7u4aAZbzaE8bfY9zoTxBF9v5qM657CfZuovj9YLJ, nft account CZKWBcwfWJmMPkXdEDKZ3XKaBpzc28UaRxjHoo6Q9rTz, owner CaEb7ChaTN1XnXfDosxRzHp3Um48av3sYE3ifU3MiQJN |
| swap-near-pstar | a real swap pays within 1.5% of P* (0.30% fee plus the price impact of 0.55% of depth) | PASS | [3jEhEYkf…](https://explorer.solana.com/tx/3jEhEYkfakJJ2LAotJn1eFgVtWzLinmeQiQcYs3M298bQtQpuPueW8ghAQreW2P1jAZcndJcAy438L1gFEtWyMaG?cluster=devnet) | 5000000 base in → 6444695 quote out; 6500000 at exactly P*; ratio 0.99149 |
| swap-model | the amount received matches an independent constant-product model within 0.05% | PASS | — | received 6444695, model 6444696.1 (gross 6464088.4, fee 30 bps), error 0.0000% |
| swap-pool-price | the pool price moved down to the modelled price after base was sold into it | PASS | — | sqrt price 1.140175425099138 → 1.133876113359538 (model 1.133876113359538) |
| cost | the whole run, including rent for the cross, mints and pool, fit inside the 2 SOL cap; the remainder went back to the promiser | PASS | — | creator spent 0.07334036 SOL, returned 0.08332732 SOL |
