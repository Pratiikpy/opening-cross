# D5 — Verifier sweep over every cross_core cross on devnet

Run: 2026-10-12T03:54:33.942Z · RPC https://api.devnet.solana.com · program `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`
Script `tests/devnet/src/verifier-sweep.ts`; every cross is judged by spawning the published command `opening-cross-verify <cross> --rpc <url>` (packages/verifier/src/cli.ts), which reads the cross and its book from the public RPC and recomputes the clearing with the second implementation (`referenceClear`).

Overall: **NO MISMATCH** — 48 cross accounts: 38 verified, 0 mismatched, 10 not yet cleared (nothing to verify), 0 unreadable.

## Accounts owned by the program

| Discriminator | Kind | Accounts |
|---|---|---|
| `86addfb94d561c33` | Order | 174 |
| `e870eec7afa7bfa7` | other program account (shard, book, protocol, …) | 127 |
| `57d37eb097cdabeb` | Cross | 48 |
| `2d27652b73488328` | other program account (shard, book, protocol, …) | 1 |

Total program accounts: 350.

## Crosses

| Cross | State | Verdict | On chain | Recomputed | Book levels | Note |
|---|---|---|---|---|---|---|
| `ps6kAXQFZ2XawW92G3BALzLdxfEpTWJWaKAtykYnSTH` | Finalized | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `24X89kV5CULdgXLxWD99ZN2uQSzC6asUwNXbxct8AhR4` | Finalized | **VERIFIED** | no print | no print (BelowMinimumVolume) | 2 | no print (BelowMinimumVolume) |
| `2E7Qg6kT94qjbo1AT63TLv5TpPahnqLLQRJD3YJhKPGE` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `2gS3tViAZu8se7AwBBBdSy6ty6517m7cCZg5ncbT1ReZ` | Finalized | **VERIFIED** | P* 1300000, 80000000 | P* 1300000, 80000000 | 2 | printed at 1300000, 80000000 matched |
| `2qSzjGFdbmx84HBZ6ZBQogpgBo1Qj6GTmieRz74iwZz5` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `3B697sH93eaqYmtzNdp4CuLk8BFcRHKuoC2optCuwqD7` | Cleared | **VERIFIED** | P* 1000000, 1000000000 | P* 1000000, 1000000000 | 2 | printed at 1000000, 1000000000 matched |
| `3R8XaFKxXQ64kbN6Uq3gp4D1M51UsggqF6UHZ5uYYn6m` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `4KVXShURQaHof5D6987EUKUPeUxL81GB6oVZdLRvyC7n` | Finalized | **VERIFIED** | P* 1000000, 1000000000 | P* 1000000, 1000000000 | 2 | Cleared, then abandoned by its settlement adapter after the deadline; every order was refunded. |
| `5UfrmxAv1qQakpSp8fJ8yD2Jx3nekb4nu8HjsF2wA8Wm` | Finalized | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `5UiovKjc7eG2rwV5uRjVb2d6vbwjk2F1XEjzYuLRnJBk` | Live | **NOT CLEARED** | no print | — | 1 | still Live on chain (close 1791769142, reveal end 1791769142); nobody has cleared it |
| `5ZoakEPYXH97Bahqk42jG4scVCeATnzKHtMPeQW8Kfzs` | Live | **NOT CLEARED** | no print | — | 2 | still Live on chain (close 1791737975, reveal end 1791737975); nobody has cleared it |
| `5dzZqtppShDsd4sGMMj8bcZTQgFwyBXRYPeBMDAjCupB` | Cleared | **VERIFIED** | P* 1000000, 1000000000 | P* 1000000, 1000000000 | 2 | printed at 1000000, 1000000000 matched |
| `5fxcGkrPRWAToX92yNA14YYADieSFR2U1S9cwLDfpkuf` | Live | **NOT CLEARED** | no print | — | 2 | still Live on chain (close 1791769084, reveal end 1791769084); nobody has cleared it |
| `5xvkNBtWD6qqJRjWtKEoVd6R1wBZ4bfmn8TeecHChewv` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `63VrdWAzPrBi31oitk2Nk9YvjASaEJT7msJ8Ci6WmVB2` | Cleared | **VERIFIED** | P* 1000000, 3960000000 | P* 1000000, 3960000000 | 10 | printed at 1000000, 3960000000 matched |
| `6NrhAQBEmcWgPcceCZMZ7tpJiy1BdvyXnAWJn7KwGRGt` | Finalized | **VERIFIED** | P* 1300000, 80000000 | P* 1300000, 80000000 | 2 | printed at 1300000, 80000000 matched |
| `73A4bRkU9YZJB46h1ktuFSyG1epVgx1huBY1Z7KsEwTE` | Finalized | **VERIFIED** | no print | no print (BelowMinimumVolume) | 2 | no print (BelowMinimumVolume) |
| `7G1iEGmX6mqW3QzJoNMjsDWL2yUn65ocKq4p7x7ZZCBC` | Finalized | **VERIFIED** | P* 1000000, 400000000 | P* 1000000, 400000000 | 2 | printed at 1000000, 400000000 matched |
| `7qykvjZX3YHG2wNeG9ey3z8uzsFoMBW8unN5qcEW9pnQ` | Cleared | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `8MWWeu2kE4AWZ5UnEYsP5qr7pwaMBPojMfWAd5nMjASG` | Live | **NOT CLEARED** | no print | — | 1 | still Live on chain (close 1791771183, reveal end 1791771183); nobody has cleared it |
| `8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx` | Finalized | **VERIFIED** | P* 1500000, 2500000000 | P* 1500000, 2500000000 | 3 | printed at 1500000, 2500000000 matched |
| `8fLAspsbLZNmf4EDYGuKACTRc1dLgKzCAM3zunpjip3y` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `8hinNcEt7FWgNhaJgEufzUTz8bVHT89a2Zeo8LoW3ZCU` | Cleared | **VERIFIED** | P* 1300000, 80000000 | P* 1300000, 80000000 | 2 | printed at 1300000, 80000000 matched |
| `9H36pnuSqYn9q1x8c4gt2CMn8erchZFX8EDKnyd99vRJ` | Live | **NOT CLEARED** | no print | — | 0 | still Live on chain (close 1791774676, reveal end 1791774796); nobody has cleared it |
| `9k56iTnSUx6AbFRk6J2jHmttLT5SmUGupP7CpLES5PjQ` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `A59u6EBpQg477A4yuBnZDtYYeXFfsuLDoYniVDrdFx8L` | Finalized | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `ADrdorPsoqd8sQMJNiBMMgZDC8pszZM3uXX2zpyzdDCp` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `BKk7e1qcXn5Dk1oQGN2ygYjzWobzvKG8eehJpSRn84nS` | Finalized | **VERIFIED** | no print | no print (NoCross) | 0 | no print (NoCross) |
| `C9H3NiKL5YaZNyshPydA6FTzMQdGcRv7zHHf6X3Ba1wA` | Finalized | **VERIFIED** | P* 1000000, 500000000 | P* 1000000, 500000000 | 2 | printed at 1000000, 500000000 matched |
| `CSwmiDtBxkUsvWSsvE5re2CXft63hHEvwnj4ZdpRyCnR` | Finalized | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `CYg6wAhxMdkSV7UmAAH6MZFAiHu6iZ1f4sKtiTTzj1xt` | Cleared | **VERIFIED** | P* 1000000, 500000000 | P* 1000000, 500000000 | 2 | printed at 1000000, 500000000 matched |
| `CZHQQfvbCd7PVugLiv9unVTWExpcK6CTimwFfnB9zZdC` | Finalized | **VERIFIED** | P* 1500000, 2500000000 | P* 1500000, 2500000000 | 3 | printed at 1500000, 2500000000 matched |
| `Cca9bGbtuG8HzJdSDg9CLTJtcdwd7uADBA6cFQjXYvpr` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `CmL4Pp5xGu9zqBw7xtiXN4XebPRNp5614C4ECtGes6fh` | Live | **NOT CLEARED** | no print | — | 2 | still Live on chain (close 1791768077, reveal end 1791768077); nobody has cleared it |
| `Cw2NBgLdsWTaU8FAZVgbkC3RZq6fQ39CnTfEuHCD9ktb` | Finalized | **VERIFIED** | P* 1300000, 80000000 | P* 1300000, 80000000 | 2 | printed at 1300000, 80000000 matched |
| `DCE38rv4jem4NeBsXoUJVvnNUSe6AdGELFHNMQVgo6og` | Finalized | **VERIFIED** | P* 1200000, 2000000000 | P* 1200000, 2000000000 | 4 | printed at 1200000, 2000000000 matched |
| `DZydP8xJgVDveQ7LpPrpeZ5XYvmw5zPqxjxCE25PWcZo` | NoPrint | **VERIFIED** | no print | no print (BelowMinimumVolume) | 2 | no print (BelowMinimumVolume) |
| `DteKUFETfu3d6Dj6PzL9Po4FNxFZddBtVPwK9B5biV7K` | Live | **NOT CLEARED** | no print | — | 3 | still Live on chain (close 1791192593, reveal end 1791192593); nobody has cleared it |
| `E2uWUxMuzzBUVaAadsV8pFdza5ymdQz2BPwC9KT3UNXC` | Finalized | **VERIFIED** | P* 1300000, 2800000000 | P* 1300000, 2800000000 | 3 | printed at 1300000, 2800000000 matched |
| `EMmoeu8LYuFvDmiTYxbHaBZetUTHxsAABzs3jZ3Htg8H` | Finalized | **VERIFIED** | P* 1000000, 1000000000 | P* 1000000, 1000000000 | 2 | Cleared, then abandoned by its settlement adapter after the deadline; every order was refunded. |
| `FQD8KLfm3GX3ZspY4sTLzjaBmMSUpuqKNgcCcoMSbSkW` | Finalized | **VERIFIED** | P* 1000000, 400000000 | P* 1000000, 400000000 | 2 | printed at 1000000, 400000000 matched |
| `GArvw6L46Fw4PzAwj5o1Vc2BB82GPC34Whihd6Wve9tC` | Live | **NOT CLEARED** | no print | — | 3 | still Live on chain (close 1791774706, reveal end 1791774706); nobody has cleared it |
| `GBWtEd9BapdNyc9cBn6V4aZcQCbMHegFqGFnTK9tkRGx` | Cleared | **VERIFIED** | P* 1000000, 1232000000 | P* 1000000, 1232000000 | 10 | printed at 1000000, 1232000000 matched |
| `H5CEbW6qTMYm525BnKk46RLXDASmhVswTauiM9fXBkUu` | Finalized | **VERIFIED** | P* 1000000, 500000000 | P* 1000000, 500000000 | 2 | printed at 1000000, 500000000 matched |
| `HLdj3Y3sYGMgpjpaLKhToFbxDLg5CFR5mLg37NSg7WrA` | Finalized | **VERIFIED** | P* 1500000, 2500000000 | P* 1500000, 2500000000 | 3 | printed at 1500000, 2500000000 matched |
| `HeTTgSpL1TkaQddDy9vvkGLP8u3h6kMvb9vUBoMbbK7P` | Live | **NOT CLEARED** | no print | — | 2 | still Live on chain (close 1791767440, reveal end 1791767440); nobody has cleared it |
| `JAspknVztN62MdAQcYJ1S79UEfDrSkzPZud8egAHijtF` | Finalized | **VERIFIED** | no print | no print (BelowMinimumVolume) | 2 | no print (BelowMinimumVolume) |
| `JDWYWieAimSL6FvaUd9iNaKhDSrshF4oEQiR7iSARcXt` | Live | **NOT CLEARED** | no print | — | 2 | still Live on chain (close 1791767094, reveal end 1791767094); nobody has cleared it |
## Reading this sweep

- 48 cross accounts exist on devnet under the current `cross_core` layout; all 48 decode. 38 have cleared and every one of them verifies: the recomputed price, volume, rationing side and print/no-print reason equal the on-chain record (this includes the four crosses of the D2 run: a printing launch, a sealed cross, a no-print and an abandoned deferred-mint launch).
- The 10 "not cleared" crosses are Live accounts past their close time that nobody has cleared (two belong to an aborted attempt of the D2 run; the rest are earlier work from other runs, the oldest from the first devnet deployment). The verifier has nothing to recompute for them, so they are neither verified nor mismatched. Clearing them is permissionless; a keeper without a creator scope would do it.
- Finalized crosses keep their book account, so the verifier can re-check them after settlement.
- What broke: the published `opening-cross-verify` crashed with a raw HTTP 429 stack trace on the public RPC. It now retries with backoff (`packages/verifier/src/rpc.ts`, test `packages/verifier/test/rpc.test.ts`) and exits 2 with a one-line message when a cross cannot be read (0 verified, 1 not verified or not cleared). The `--rpc` mode of `opening-cross-verify-promise` uses the same client.
