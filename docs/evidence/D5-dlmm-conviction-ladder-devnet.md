# Devnet proof — DLMM conviction ladder above P* (M2)

Run: 2026-10-13T01:34:52.303Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/dlmm-ladder-proof.ts`
Programs: cross_settle `2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ`, lb_clmm (DLMM) `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` — both executable on devnet

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | fresh creator J8Kpv4zq41mEjzPBnK4SssyBruuU2gDXAh8x464xJHUs funded 1.5 SOL from the promiser key | PASS | [misDj9G8…](https://explorer.solana.com/tx/misDj9G8tthMVGReDkWueYdMNWoJH2u5WsALnrdTS2tjeEEDHMqEVRA3PQ2Efrj81mcmdD3UGuSCuXTs57PYQHn?cluster=devnet) | bidder 7mRn1jRfk1i8Qw7GPu7Tw7rD1YD6XuWYV7jrREzRZ1bB, trader 9QnLhetWeT1tMmGPbqdKcGW82twrbhfnPEF2WDmhq3KZ |
| cross-create | mint-mode launch cross created on the deployed cross_core; the cross PDA holds the base mint authority | PASS | [2CnRgYzh…](https://explorer.solana.com/tx/2CnRgYzhRRDSYYv1brHdqxpSr48nzsgVAVAMYND65Udpvn2UtuWqJWnNg5veGVgQLGRCAqArMjQAQxN4HxbhUQh8?cluster=devnet) | cross 8fE1rFQ4a6HZtevFKsc2SaeGei1SYLWtiX7LNAnUQNES, base BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt, quote B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ |
| bid-0 | bid 1000 tokens at 1.6 escrowed | PASS | [2wEFYPZ8…](https://explorer.solana.com/tx/2wEFYPZ8muKax8wKy3wJeymYerHkabf53XQ8JuLNfutpcya3tcAEupA4nmh8hBnCKyzV77S1NL8Hz1nwf9Um9aoV?cluster=devnet) | bidder J8Kpv4zq41mEjzPBnK4SssyBruuU2gDXAh8x464xJHUs |
| bid-1 | bid 1800 tokens at 1.3 escrowed | PASS | [3dfV983S…](https://explorer.solana.com/tx/3dfV983SWzY8QUymTry2yLwBeku79bjdkuN7CYK41HnSg16QLLjfb4ojAD436Fdpbm3nLP9zyunQTEK6YxknkMVq?cluster=devnet) | bidder 7mRn1jRfk1i8Qw7GPu7Tw7rD1YD6XuWYV7jrREzRZ1bB |
| clear | on-chain clearing price and volume equal the independent reference | PASS | [3VC3UMhR…](https://explorer.solana.com/tx/3VC3UMhReDSM8N8R1K92vdfFSrPyoWyJqSZzNJRM6Y6Mr8sb3zDLi2kZRcNtgwLECqHVDxPRouM842y5TKzv4TBw?cluster=devnet) | P* 1300000 (reference 1300000), matched 2800000000 (reference 2800000000) |
| claim-0 | claim minted the fill at P* and refunded the escrow above it | PASS | [5RLbTRCj…](https://explorer.solana.com/tx/5RLbTRCj5nqoWgVL82hUdCpRoqPY8cEzc4df6VNQtUESCss5zSyJP7xcbZtMhJCq41VhpUSHRJ2bVoVNwMfi4beQ?cluster=devnet) | fill 1000000000, refund 300000000 |
| claim-1 | claim minted the fill at P* and refunded the escrow above it | PASS | [5xPZpv6J…](https://explorer.solana.com/tx/5xPZpv6JybLx5RjV4btMoJN2ANwD1kvtLev9n4dV7wN9qYbP7u2tKKCN4cgLQZTfmrnHU5YfBhVFTSXRxNFpSgAm?cluster=devnet) | fill 1800000000, refund 0 |
| finalize | cross finalised on chain | PASS | [2BzDn24Q…](https://explorer.solana.com/tx/2BzDn24QyrUb5fCg8KEn9AbPnTzijr6DPZf9FmXVcSWsHpRz1rRfEZ4qTnLgT5ZSj8ZbsK3fu6hAsdUuGJnL7MUT?cluster=devnet) | state 3 |
| pair-open | the DLMM pair opens through cross_settle with the active bin holding P* | PASS | [mBNLCL2K…](https://explorer.solana.com/tx/mBNLCL2KtwLGTde3naakjKJ6u1znU4WLM1Pt7JgZua1U6aZpUosVHwnx17G5jmNhR5SHdZSj7nXgneWS9GWRiX7?cluster=devnet) | pair 9ND3Gwnt5v8HVduCNKBozEuXTKwpXjtV3TMQDY9GctYG active bin 262, P* 1300000/1000000 |
| ladder-span | the ladder covers exactly 20 bins, all above the active bin | PASS | — | bins 263 to 282 (active 262) |
| ladder-deposit | the issuer's base tokens left its wallet into the pair's base reserve, and no quote was deposited | PASS | [45uHCb7b…](https://explorer.solana.com/tx/45uHCb7bSYG9ontKUSqePUPzn7WbNoACyS9asfPEEeWfzs3Kxe2hSf6JAfmFaCQBy3HYLkKuGLwz47eTcZCTkjZo?cluster=devnet) | wallet −899999990 of 900000000; reserve X 899999990, reserve Y 0 |
| buy-small | a small buy is filled from the ladder at no less than the first ladder bin (less the pair fee) | PASS | [3kunZ9tc…](https://explorer.solana.com/tx/3kunZ9tctTQrjZcpEHsPEyZDsoEzhSNTLnHNYnUNrGhkMqzTdTXRKdNAG1QSpgUYwzST3UNqgMFvSjk7evQX9Hsx?cluster=devnet) | 100 quote → 76807023 base, average price 1.301964; first ladder bin 1.300656, P* 1.300000 |
| buy-large | a larger buy climbs further up the ladder: more tokens, a higher average price, never above the top bin | PASS | [2KRwGRWW…](https://explorer.solana.com/tx/2KRwGRWWuWjZFCPc5RrBDhJNCK5hAin6bzZz87ELqxLAqcUARq7QSkQUKqouUanLfRFfxqNDhQzmNqDUTC8bs9bW?cluster=devnet) | 500 quote → 382901904 base, average price 1.305817; top bin 1.325592 |
| reserve-accounting | the base reserve fell by exactly what the two buyers received | PASS | — | reserve X 899999990 → 440291063, buyers received 459708927 |
| cost | leftover SOL went back to the promiser | PASS | — | returned 1.16380532 SOL of 1.5 |
