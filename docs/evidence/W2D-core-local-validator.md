# Local validator proof: cross_core rules extension (W2D), NOT a devnet result

Run: 2026-10-13T18:23:03.009Z · RPC http://127.0.0.1:8899
Script `tests/devnet/src/w2d-core-proof.ts`
Program: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`
Rows exercised: B14 (ending and draw on the cluster block hashes), W4 (referral share), B5 (minimum raise, pushed refunds).
Cluster: `solana-test-validator` running the locally built `cross_core` binary and its own Token-2022 and SlotHashes. The devnet run is `scripts/deploy-batch-2.sh` (HUMAN_TASKS H27).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| A-rules | rules written in the creating slot: 2 ending buckets, random end, 25% referral share, minimum raise 1 | PASS | [5VeYVCkB…](https://explorer.solana.com/tx/5VeYVCkByHnaAWaW3jQ9ZZy7eK7KWuUTkGBaykpfQ5UPayW8Zd5f836q5qit6d8MoDmU8MJHwJnz1wucWo56JwgZ?cluster=devnet) | cross H9GBWHUQhCSVN2YEmojWe6oRfm68SZoNQL9La8TxchGG |
| A-buckets | orders landed in the bucket of the instant the chain clock saw them (main, main, 0, 1) | PASS | — | buckets 255, 255, 0, 1 |
| A-draw | the draw finished on the cluster block hashes and fixed the last counted bucket | PASS | [47eXdwsb…](https://explorer.solana.com/tx/47eXdwsbgfQ4hSdyYevwsN8LUZiXQbj5Gmjfh2ipADhuFouEVqrruMQmkRdbERnmvfz1k9YwYL13Za7qGryc5JvF?cluster=devnet) | last counted bucket 1 |
| A-clear | on-chain price and volume equal the independent reference over the orders the draw counted | PASS | [UopXRNDv…](https://explorer.solana.com/tx/UopXRNDvRuhGwK8hUCTMH2XQE8aJAQnZPjw32Zj3nWkzTWUYM4dVtdCgHDbdA18xLuSzoEMmnqGgZddmpGvAqVN?cluster=devnet) | P* 1400000 (ref 1400000), matched 2000000000 (ref 2000000000), counted 4 of 4 orders, last bucket 1 |
| A-claim-0 | bucket main order filled as the reference says | PASS | [34bT7GLj…](https://explorer.solana.com/tx/34bT7GLjWJgRY81wGmqiDmRt53jECroBjwyEE553HX9wbzkErxbyEsnjfQkoeXXMmSEeYjGk2auEUc9L2yLhgjYU?cluster=devnet) | fill 1500000000 (ref 1500000000), refund 150000000 (expected 150000000) |
| A-claim-1 | bucket main order filled as the reference says | PASS | [Nxy9Ym7S…](https://explorer.solana.com/tx/Nxy9Ym7SCtNcEnYaX4Q9o12JWdVpeQe43SnxBtpxCidGhzd6WZikFECnUzk71hrYvv1ube2g93uB13pcD2raXsj?cluster=devnet) | fill 0 (ref 0), refund 960000000 (expected 960000000) |
| A-claim-2 | bucket 0 order filled as the reference says | PASS | [dhQJxG8Z…](https://explorer.solana.com/tx/dhQJxG8Z9hBPWXcFi3Kmm3zEeoLC6hnuoM3zteViCXA3QFSKMGzuHVwfuhx2suiZsaw9U3nHWC8jyGxcdG3qbfd?cluster=devnet) | fill 0 (ref 0), refund 660000000 (expected 660000000) |
| A-claim-3 | bucket 1 order filled as the reference says | PASS | [3PoVPcfk…](https://explorer.solana.com/tx/3PoVPcfkz8WFMpCAKgJi1CBGbcuwmhkQ3X4EYmTCJ4QvG4qyAu5oehdNosGyAe8ab3nRvMH77ypGvceqFY2KCMcH?cluster=devnet) | fill 500000000 (ref 500000000), refund 280000000 (expected 280000000) |
| A-fees | fees on the buyers payment: protocol 30 bps (capped at a fifth of the total), integrator 200 bps; the issuer receives the payment less both fees, plus its returned creation deposit | PASS | [2hKhGr6S…](https://explorer.solana.com/tx/2hKhGr6SUyzyvwsnujsDSdVB2oVWwp9DphYM9mPzdpzCv3BNywZNjL9nQtgVQnNwmLJxekvKA4BREjcv8ykRfL3Q?cluster=devnet) | payment 2800000000; protocol 8400000 (expected 8400000); integrator 56000000 (expected 56000000); proceeds 2735600093 (payment less fees plus the creator's returned deposit 93) |
| A-referral | the referrer receives exactly floor(protocol fee x 25%), the fee recipient the rest, and the vault ends empty with the mint authority revoked | PASS | [2hKhGr6S…](https://explorer.solana.com/tx/2hKhGr6SUyzyvwsnujsDSdVB2oVWwp9DphYM9mPzdpzCv3BNywZNjL9nQtgVQnNwmLJxekvKA4BREjcv8ykRfL3Q?cluster=devnet) | protocol fee 8400000 = recipient 6300000 + referrer 2100000; vault 0; mint authority None |
| B-no-print | a minimum raise nobody can meet: the cross does not print (reason BelowMinimumRaise) | PASS | [ungZMc1k…](https://explorer.solana.com/tx/ungZMc1k5hhjMu7NhhYsTAZDrwJCZx1AbcCLWzYadiJiZrYChsrJEj6A4BkHvLWmGJh3eks5ESfj17hoJoV6FRR?cluster=devnet) | state NoPrint, reason BelowMinimumRaise |
| B-push-refunds | one transaction, signed by neither owner, returns both escrows in full and closes both orders | PASS | [21kmzU1j…](https://explorer.solana.com/tx/21kmzU1jVHgAjpwNSiV3hSGkhF3zoWT62irdEiDEsECZAb2JFEodxfYcXq8LAYcdsZPnVtGVzs4NhYbunwbjg7FH?cluster=devnet) | refunded 650000000, 480000000; orders closed true, true |
