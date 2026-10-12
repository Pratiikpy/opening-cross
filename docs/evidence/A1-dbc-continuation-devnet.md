# Devnet end-to-end — Meteora DBC continuation (A1)

Run: 2026-10-12T01:24:18.794Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/dbc-continuation-e2e.ts` (drives `@opening-cross/sdk` and `@opening-cross/adapters`)
Programs: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`, Meteora DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`

Flow: deferred-mint cross (settler = the cross_settle PDA) → two real bids → close → settle → `open_dbc_pool` by the creator → `bind_dbc_mint` → claims → finalize → a swap on the live DBC pool. Every figure is read back from chain state; the clearing result and the fills are compared with `@opening-cross/verifier`.

Not covered: the curve reaching its migration threshold and the move to DAMM v2 (that path is DP6 in `DP-dbc-hook.md`, run on a hand-built config, not on a pool opened by `open_dbc_pool`); an allowlist-mode gate on this pool (the adapter installs the gate in open mode, so the swap shows the hook executing, not a pass being enforced); one winning bidder only (the second bid sat below P* and was refunded in full); a sealed disclosure cross feeding a DBC pool.

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | fresh run key funded from the devnet promiser (devnet only, 0.35 SOL) | PASS | [ARqceaia…](https://explorer.solana.com/tx/ARqceaia3uzJeKnTLGymJJirXPJhCXtEWK62qKnGKjYmkNnEq5DDfmewwo26v6zNvkpkx6Eh1Ym3S8AHxDH6HWp?cluster=devnet) | run 61KHgAN2Zxc27MCSSRn3yzVFFm5eqgkStbhngsRmPKz3, promiser 2ojpxet1udXmiseTnkHJJ6zZKKUDFCjpWTxMVVcKe93B |
| create | deferred-mint cross created with the settler PDA as its settler and no base mint | PASS | [3venrt8F…](https://explorer.solana.com/tx/3venrt8FVi2UHVmFEZDZmxoUrptW7XDmXAddBVgg4rja9XTCC7u1ngqCq6RtNLfvHfQeYFpxjb8RvmMD9C7KnsFj?cluster=devnet) | cross 8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx, settler HoRd6N1Kmfc4C4V25PMyLUS7H9PDqYKvJ5ZCymQUccVY |
| bid-0 | bid 2500000000 at 1500000 escrowed | PASS | [4ucCCSyn…](https://explorer.solana.com/tx/4ucCCSyn5gijn3bmRqyxr3Gt2iR6mnWQXwuyvz2CjSpikWN6T3A3gpx4Zj7M5PxCq5AK3FxTjfv6TLGeLog8CRrB?cluster=devnet) | buyer 4vYBd5RKPj2GEUDGzeDeYnetSiT8xHftDyM6FZBaq5tu |
| bid-1 | bid 1000000000 at 1100000 escrowed | PASS | [4BnPoiKc…](https://explorer.solana.com/tx/4BnPoiKc4Hz1gzJ7bbbhZ7Y6oPfYSqpRvZFs2NfqzgtpDBSbR8K5m4yTi4WQytivGPh2e25E6f8CANAKRie1gxfy?cluster=devnet) | buyer 74TMGLFPYuGE9X9LQVzcBLXM72SXN8bTne1wsP2C25Sa |
| clear | on-chain clearing price and volume equal the independent reference | PASS | [46U4dU2z…](https://explorer.solana.com/tx/46U4dU2zQGhaLmCUA6LhppZmLZ5c82EpmTTFNqt5QC6WrsDLPKD4JLTCKbbxnMBA3y8aMRRy9NEDsx27JdbtP18E?cluster=devnet) | P* 1500000 (ref 1500000), matched 2500000000 (ref 2500000000) |
| refuse-start | a DBC pool whose start price is one tick off the clearing price is refused | PASS | — | StartPriceNotClearingPrice |
| refuse-creator | a wallet that is not the creator cannot open the pool | PASS | — | NotCreator |
| refuse-bind | binding before the pool exists is refused | PASS | — | Program log: AnchorError caused by account: base_mint. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized. |
| open-dbc | open_dbc_pool created the live DBC pool; its sqrt_price equals sqrtPriceQ64(P*) | PASS | [3cUyecZW…](https://explorer.solana.com/tx/3cUyecZWb1sa5gch4vH9rsvr1ZrH8VqB3YDr1f5ZkB87kbVM1DWF67yEb9s3GY5yckbHYcsNknS5yfBfUjVid1wa?cluster=devnet) | pool FJ8GVeLdimyLyinn9qp5sT9PdsYfV8UQCMcM2dYuywv7, sqrt_price 22592555198148962256 (expected 22592555198148962256), compute units 152915 |
| refuse-reopen | opening a second pool for the same cross is refused | PASS | — | Allocate: account Address { address: C7U162LbH24RmWuUJchNQiMELNDFpLifzrkJc3b7SE38, base: None } already in use |
| bind | bind_dbc_mint bound the continuation mint to the cross and moved its mint authority to the cross | PASS | [3uttgSXJ…](https://explorer.solana.com/tx/3uttgSXJaPuSGNy5VuS2m15eG7mJyUMTfwynuVSuHTwYNvU8RDTFdCvPkzj1WHTvC4tS27HKXdoKprZq5YNHsrR3?cluster=devnet) | base mint 25cCfJdw3oJpSgyptftMaJ1HudqhqwSREHj9A5ymwb7m, mint authority 8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx, compute units 56129 |
| claim-0 | claim minted the fill at P* and refunded the escrow above it | PASS | [43EnuSeP…](https://explorer.solana.com/tx/43EnuSePgE9c2qNUxErVgim4wgJLRSKLJxXSQCVVTCBbf1uXATHEGsiK7BWUVhHrYni5DhFFAStUJC4M2vaP9jAG?cluster=devnet) | fill 2500000000 (ref 2500000000), refund 0 (expected 0) |
| claim-1 | claim minted the fill at P* and refunded the escrow above it | PASS | [j5m6txzA…](https://explorer.solana.com/tx/j5m6txzAQ9tebFQNYavPFDjoGS2aGs9A4urYySs4TF4XuCM5gUE6KgcABvrNa76K22jtaqiEA4mWLD7p2fyJVeE?cluster=devnet) | fill 0 (ref 0), refund 1100000000 (expected 1100000000) |
| finalize | finalize: cross Finalized and the base mint authority is None | PASS | [3ya7Ges6…](https://explorer.solana.com/tx/3ya7Ges6uDk797QFmMzkMv3PruVjQFZ8j71Gb6jSd1Chm88fvVoFtSvFhnJVsoSDguLeAYCYcF1f9jMWtYdMqyta?cluster=devnet) | state Finalized, mintAuthority None |
| supply | mint supply is the DBC vault plus exactly the claimed fills, nothing else | PASS | — | supply 1000002500000000 = vault 1000000000000000 + claimed 2500000000 |
| gate-ran | the swap executed the cross_gate transfer hook that bind_dbc_mint installed on the mint | PASS | [3Bffnhc9…](https://explorer.solana.com/tx/3Bffnhc9CyjoBWVh9JmaM9bXsEdiVGbfTv79VVeNCeNjnWuo87sGATCE8DpwTarhD5KXnotVvRG7ThQDiH2KQzhN?cluster=devnet) | hook program on the mint 2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr; cross_gate invoked in the swap: true |
| swap | a claimed winner buys from the live DBC pool at the clearing price plus the 1% fee | PASS | [3Bffnhc9…](https://explorer.solana.com/tx/3Bffnhc9CyjoBWVh9JmaM9bXsEdiVGbfTv79VVeNCeNjnWuo87sGATCE8DpwTarhD5KXnotVvRG7ThQDiH2KQzhN?cluster=devnet) | paid 50000000 quote atoms, received 32999998 base atoms (expected 33000000 from P* and the fee) |
| budget | the run stayed inside its funding; the unspent balance went back to the promiser | PASS | — | net spent 0.13005656 SOL (rent held in the cross, DBC and token accounts included); returned 0.21994344 SOL |
