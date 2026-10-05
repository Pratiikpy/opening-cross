# Devnet end-to-end — cross_core (C2)

Run: 2026-10-05T09:30:25.409Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/core-e2e.ts` (drives `@opening-cross/sdk`)
Program: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| protocol | protocol already initialised | PASS | — | protocol 9PMi5EbYJ9YfpVcDgBUKfkTJeegcSWGEMMtXiRUgHx6G |
| launch-create | mint-mode launch cross created; cross PDA holds the base mint authority | PASS | [2ojGJKS5…](https://explorer.solana.com/tx/2ojGJKS5qs2hMdyjzCUkATYrM1CNh6gtfFEWM5qGKZFed489V9yQJJ2SGNGhZj1ZTdLtNrBFpHoBUJrXwSZC148R?cluster=devnet) | cross 7qykvjZX3YHG2wNeG9ey3z8uzsFoMBW8unN5qcEW9pnQ, base GvbcttW5sRicwyve21hjuDhxfLbUCuF7mxCLn2cGoDAt, quote CmCRp2EzxzvWyirYZWqwxjtU1TEXY9YfaJA9zf3rj5LQ |
| launch-bid-0 | bid 1500000000 at 1500000 escrowed | PASS | [5p9v1nzW…](https://explorer.solana.com/tx/5p9v1nzWsEq6AR5bx4sRE3NLfJ7ubEjPusRTXS1PNeAvVLwmxRDpn6Tj66B2g8pnwSEzWgj3nZnxJi5SA6t562dG?cluster=devnet) | buyer HstDfMrJFqeDBakLsuQ4rQSPFPDiV9npcPCz3eWTRx3L |
| launch-bid-1 | bid 800000000 at 1200000 escrowed | PASS | [PFxk4Mju…](https://explorer.solana.com/tx/PFxk4MjueDgsn3oFivr7D7ZFXNYEbPrk5rurHZTvB3ANupyNpxkbXi9zv9xK7YziVrJC2D8fZ5EikfUZ2HNyHoH?cluster=devnet) | buyer 5WS5yzCRjKryGboAZ2cbvs5H59YDKeYaypx2QeMX4mMm |
| launch-bid-2 | bid 500000000 at 1100000 escrowed | PASS | [SFYZAvub…](https://explorer.solana.com/tx/SFYZAvubBPwvr6c36u6QQsQmL3feH41DLs8PEBiQaiSozd9jPwhEaMujEESYAWGydmkDErVto3kKzvSj9xVPEtT?cluster=devnet) | buyer F5eYyoaBy7ksxCEHDmr1bubabCGHktKzFvRSVATnLztU |
| launch-clear | on-chain clearing price and volume equal the independent reference | PASS | [631v5VGc…](https://explorer.solana.com/tx/631v5VGcBVcuanYtWRfGdcf9UtXEqw447JXoLVCxe5Qd7spGGhgTH3eXhStGDJD82G5tZVUvfCAWiSTBRWjMVAfC?cluster=devnet) | P* 1200000 (ref 1200000), matched 2000000000 (ref 2000000000) |
| launch-claim-0 | claim minted the fill and refunded escrow above P* | PASS | [4ZTFL1FL…](https://explorer.solana.com/tx/4ZTFL1FLTegqpv488vQTATiWU8B9zEATLpPhMq6izahySq3qZ7BEJH7xN1VRZm8K5tarV5AwyUejCDGxH8aAgEPv?cluster=devnet) | fill 1500000000 (ref 1500000000), refund 450000000 (expected 450000000) |
| launch-claim-1 | claim minted the fill and refunded escrow above P* | PASS | [2DKuP3Uh…](https://explorer.solana.com/tx/2DKuP3Uhda2JwgotGUiEXGDLmGhLiyTjw2D6TGMnUBPgXBuhQBwzNYxaQrnJCHMhGnw13Kzc3Labjw2cDoDtE4iK?cluster=devnet) | fill 500000000 (ref 500000000), refund 360000000 (expected 360000000) |
| launch-claim-2 | claim minted the fill and refunded escrow above P* | PASS | [gbrts7dC…](https://explorer.solana.com/tx/gbrts7dC6quMonHwuN8D5oKrkPJgkTHLtV72NUrc7pkCE8b748zMB4wEqHUc8qwxB8XBUGmpG1W8MCvbpfExrw7?cluster=devnet) | fill 0 (ref 0), refund 550000000 (expected 550000000) |

## Error

```
SolanaError: Transaction simulation failed
    at <anonymous> (C:\Users\prate\col\node_modules\.pnpm\@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e\node_modules\@solana\rpc-transformers\src\response-transformer-throw-solana-error.ts:56:23)
    at <anonymous> (C:\Users\prate\col\node_modules\.pnpm\@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e\node_modules\@solana\rpc-transformers\src\response-transformer.ts:44:57)
    at <anonymous> (C:\Users\prate\col\node_modules\.pnpm\@solana+functional@8.4.0_typescript@7.0.2\node_modules\@solana\functional\src\pipe.ts:235:36)
    at Array.reduce (<anonymous>)
    at pipe (C:\Users\prate\col\node_modules\.pnpm\@solana+functional@8.4.0_typescript@7.0.2\node_modules\@solana\functional\src\pipe.ts:235:16)
    at Object.responseTransformer (C:\Users\prate\col\node_modules\.pnpm\@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e\node_modules\@solana\rpc-transformers\src\response-transformer.ts:42:16)
    at Object.execute (C:\Users\prate\col\node_modules\.pnpm\@solana+rpc-spec@8.4.0_typescript@7.0.2\node_modules\@solana\rpc-spec\src\rpc-api.ts:135:39)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async Object.send (C:\Users\prate\col\node_modules\.pnpm\@solana+rpc-spec@8.4.0_typescript@7.0.2\node_modules\@solana\rpc-spec\src\rpc.ts:138:20)
    at async sendTransaction_INTERNAL_ONLY_DO_NOT_EXPORT (C:\Users\prate\col\node_modules\.pnpm\@solana+kit@8.4.0_bufferuti_0acacb66c8eac2d7bc7a930e27f5665e\node_modules\@solana\kit\src\send-transaction-internal.ts:82:12)
```

## Outcome of this run (2026-10-05)
Protocol init, launch creation, three bids, the clear (equal to the independent reference) and all three claims passed on devnet. `finalize` failed with `ConstraintDuplicateMutableAccount` because the operator was issuer, integrator and fee recipient at once. That is a real defect LiteSVM missed (tests always used three wallets). Fixed in `cross_core` (`dup` on the payout accounts; base mint must differ from quote mint) with regression tests in `tests/core/test/adversarial.test.ts` (48/48 pass). Re-deploying the fix needs ~3.6 devnet SOL for the upgrade buffer — blocked on human task H10; the script is ready to re-run (`pnpm --filter @opening-cross/devnet-proofs dp:core`).
