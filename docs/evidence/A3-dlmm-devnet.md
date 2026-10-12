# Devnet proof — DLMM pair opened at P* (A3)

Run: 2026-10-12T01:57:44.662Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/dlmm-proof.ts`
Programs: cross_settle `2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ`, lb_clmm (DLMM) `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` — both executable on devnet (checked with getAccountInfo before the run)

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | fresh creator EScH6fW8JR7UWHyY25dxhigWNcpq9YyZmwyy2kajDZcC funded 0.42 SOL from the promiser key | PASS | [3Z68V1Zh…](https://explorer.solana.com/tx/3Z68V1ZhLsmkg5xpMJo7AEEkN8qgmWQMzN6ga1LwENaR22cWnEtghFU1WKnv2xzcgRhvGFU3FE64v6j5yYaxkYr6?cluster=devnet) | bidder HgWYW4JSMXe4S4GioaPE5T3bxEmwou7JpkBYmUVSSqC, trader BfrnK5gPk8ce9umsehWEiWmiKCAVVkT61J7kcUzQaPoB |
| cross-create | mint-mode launch cross created on the deployed cross_core; the cross PDA holds the base mint authority | PASS | [rVgsTbKs…](https://explorer.solana.com/tx/rVgsTbKs1fW7o2DsD3Rjy6bb55dmCZZub9RnajkjoGqs9BqKjaunCqBYFCYmQ9pQksNHPsJ7jP2qU5JvXcwy1mG?cluster=devnet) | cross E2uWUxMuzzBUVaAadsV8pFdza5ymdQz2BPwC9KT3UNXC, base AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN, quote HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN |
| bid-0 | bid 1000 tokens at 1.6 escrowed | PASS | [P2uaVmSN…](https://explorer.solana.com/tx/P2uaVmSNYueV6dz4R8MfzQ9DMzPphR7aZSFsH95LgiVhPJhQFC13sE8M7M3ymscJZXDtRcKwp1ykTgF54EAaEML?cluster=devnet) | bidder EScH6fW8JR7UWHyY25dxhigWNcpq9YyZmwyy2kajDZcC |
| bid-1 | bid 1800 tokens at 1.3 escrowed | PASS | [3gjhqgMg…](https://explorer.solana.com/tx/3gjhqgMgype7RK1maoE5etkDKq7KL3XYeRKBNNTNqNMLygekKDCx3Wki6dyHzgDDZfQ3BfoRYvHVfH9KGkNbvHJd?cluster=devnet) | bidder HgWYW4JSMXe4S4GioaPE5T3bxEmwou7JpkBYmUVSSqC |
| clear | on-chain clearing price and volume equal the independent reference | PASS | [43aaNxZo…](https://explorer.solana.com/tx/43aaNxZo1NcGJnDjYNXgGxLdrjLCqUz52knzriBfCYJbcaRk5ZT1pnsc4trtLrZ5y3EVE75FdEV6UkzwESZGHsbZ?cluster=devnet) | P* 1300000 (reference 1300000), matched 2800000000 (reference 2800000000) |
| claim-0 | claim minted the fill at P* and refunded the escrow above it | PASS | [4aaSYhv6…](https://explorer.solana.com/tx/4aaSYhv6i2F3ohiS3or9p1X2jdZ6qHb6tyrvASoidd8pK1ymUrnUSRdoan53aLgsiB9WohHdtLE4fXGkY6n6imdL?cluster=devnet) | fill 1000000000, refund 300000000 |
| claim-1 | claim minted the fill at P* and refunded the escrow above it | PASS | [2YwahEoG…](https://explorer.solana.com/tx/2YwahEoGJW6RfsaKSynLd75KGnEeeiBt1kX6TEHwmgxdYt5AFhMN5znLTSWjWGZ7F1AN6hcXFe5cFinRxrzYvciz?cluster=devnet) | fill 1800000000, refund 0 |
| finalize | cross finalised on chain | PASS | [38HoLbLN…](https://explorer.solana.com/tx/38HoLbLNooxvE9ScxFR391UGWhLfZbFCBQktXpoUNhAUkfubnQoM35z43XtDu54ganwAp3KX6KkLYWWnKKyURUnZ?cluster=devnet) | state 3 |
| refuse-wrong-bin | an active bin two steps from P* is refused by cross_settle | PASS | — | P* 1300000, honest bin 262, tried 264: StartPriceNotClearingPrice |
| refuse-non-creator | a wallet that did not create the cross cannot open its pair | PASS | — | trader BfrnK5gPk8ce9umsehWEiWmiKCAVVkT61J7kcUzQaPoB: NotCreator |
| pair-active-bin | the DLMM pair account's active bin is the bin nearest P* | PASS | [5oJPttBp…](https://explorer.solana.com/tx/5oJPttBpAFEgRTBGpJpHNDK65F1HS9DTXX76M3dKgUMXbSeye9G5RpZaNeZ6Yf3uhNUmy9DzvosWuHNYTUPkcAmj?cluster=devnet) | pair 9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125 active_id 262 bin_step 10 |
| pair-bin-price | that bin's price is within half a bin step (0.05%) of P* | PASS | — | bin price 1.299356 vs P* 1.3 (off by 0.0495%) |
| pair-mints | token X is the launch token and token Y is the quote token | PASS | — | X AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN Y HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN |
| liquidity | liquidity was added in three bins around P*; the pair reserves hold it | PASS | [3wfUm3xy…](https://explorer.solana.com/tx/3wfUm3xyyhRRTkFctFUYyPF1LE8wNPFd3taADBdjm2awrBt7CpTHJm3SMeqhp5Kd2HuKQDsuaNp39Eb2mrmYzD8o?cluster=devnet) | reserve X 800000000 (offered 800000000), reserve Y 1040000000 (offered 1040000000); bin array WWDM6AdbPGZZTzuFnN54R1jbiTRz56b8gnKt9xMMQMN index 3 |
| swap-near-pstar | a real swap pays within 0.5% of P* (bin rounding plus the pair fee) | PASS | [525DF97v…](https://explorer.solana.com/tx/525DF97vgqKXNCPBzTNnD6hUA83W5bi2zYxVxFhjy6EBs679pJptuLrHio3FJrbCMYgr7y13PTwM6gJGx2Bd7M19?cluster=devnet) | 5000000 base in → 6490285 quote out; 6500000 at exactly P*; ratio 0.99851 |
| swap-model | the amount received matches an independent bin-price model (price of the active bin, base fee 0.10%) within 0.05% | PASS | — | received 6490285, model 6490285.4, error 0.0000% |
| swap-reserves | the pair's quote reserve fell by what the trader received (plus nothing else) | PASS | — | reserve Y 1040000000 → 1033509715, trader received 6490285 |
| swap-active-bin | a swap this small leaves the active bin where the cross put it | PASS | — | active_id 262 |
| cost | the whole run, including rent for the cross, mints, pair, bin array and position, fit inside the 2 SOL cap; the remainder went back to the promiser | PASS | — | returned 0.16048796 SOL of 0.42 |
