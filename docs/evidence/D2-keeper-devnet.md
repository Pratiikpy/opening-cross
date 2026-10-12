# D2 — Keepers racing on devnet (chaos)

Run: 2026-10-12T03:40:54.973Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/keeper-chaos.ts`; stack from `tests/devnet/run-stack.sh`; keepers are the real `services/keeper` process
Program: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | creator, three keepers and nine traders funded with devnet SOL (total under 0.5 SOL) | PASS | — | 411088440 lamports moved from the operator key; creator AG5huCZQuYMfXhby7n2YimQATAEUd5Q3LApfM3KewHgP, keeper A 2GvdosBdfGRJHBErQEw1j9GQa6AkKfKL3SysvCZUVg6E, keeper B 5X3FNvUN66GeF5M6AfKQoBgWiBzvNh8topsNAswNeTzn, keeper C ChncaXhmxepeQCoxuRCpaMMY7UJ6Y2GbWhYyzgTr5EYT |
| create-deferred-mint launch (settler never binds) | deferred-mint launch (settler never binds) cross created | PASS | [51P8qpDD…](https://explorer.solana.com/tx/51P8qpDD4DDjk129jGbUDNjm3LXywP93yhPDp9khs81To34YX8MKoGCmiugmarPxtvQwMvD2wEMvcjYc19HJM5nT?cluster=devnet) | cross EMmoeu8LYuFvDmiTYxbHaBZetUTHxsAABzs3jZ3Htg8H |
| create-no-print (volume below the minimum) | no-print (volume below the minimum) cross created | PASS | [9pYv4gPS…](https://explorer.solana.com/tx/9pYv4gPSLLPtLXfG3EuQZPjRTrJFiwHDfLmnNDADTjngqgydeQXtEnyTcj84Qz7Ky6ZJyWjitiyrpRVK2MbNBLo?cluster=devnet) | cross JAspknVztN62MdAQcYJ1S79UEfDrSkzPZud8egAHijtF |
| create-sealed (one bid never revealed) | sealed (one bid never revealed) cross created | PASS | [eynGPYnF…](https://explorer.solana.com/tx/eynGPYnFoM6qw2q4XoUNVCgQsDpR6UwE3WePGb5eiN528Xcqc2k7dc6EHoK2hTXHsQRbg4kEhqP7URFB4cK9BH3?cluster=devnet) | cross 6NrhAQBEmcWgPcceCZMZ7tpJiy1BdvyXnAWJn7KwGRGt |
| create-launch (open book, mint mode) | launch (open book, mint mode) cross created | PASS | [4mv1bx5k…](https://explorer.solana.com/tx/4mv1bx5kZYFQ7fpcrozHM2XiKUPxF8fYhEsVRX2ezr5sKDBPKsExLnvYxjPiigf945h9zM6chJpXX5ifC2FiKAuR?cluster=devnet) | cross 5UfrmxAv1qQakpSp8fJ8yD2Jx3nekb4nu8HjsF2wA8Wm |
| orders | 9 orders placed concurrently by nine owners across the four crosses | PASS | [4BaGfjQi…](https://explorer.solana.com/tx/4BaGfjQiH1oQgDEYLMQUfUgbhELKc2e8rWXpkBG8t7Mv5Nm6JcwPgsffYEPWYcdqYsT2HfK8DAjttKJMEaLJ7pNB?cluster=devnet) | windows close at chain time 1791775754 |
| keepers-up | three keeper processes started (A via the indexer, B and C via getProgramAccounts), each with its own payer, all scoped to this run creator | PASS | — | A 2GvdosBdfGRJHBErQEw1j9GQa6AkKfKL3SysvCZUVg6E · B 5X3FNvUN66GeF5M6AfKQoBgWiBzvNh8topsNAswNeTzn · C ChncaXhmxepeQCoxuRCpaMMY7UJ6Y2GbWhYyzgTr5EYT |
| chaos-kill | keeper A killed (SIGKILL) mid-work, after the first cross settled | PASS | — | SIGKILL to keeper A with 9 action(s) logged; keeper B has 0, keeper C 0 |
| chaos-restart | keeper A restarted 30 s later and rejoined the race | PASS | — | A done 9 · B done 1 · C done 0 |
| reveal | the two owners who revealed their sealed orders did so inside the reveal window | PASS | — | both reveals landed |
| finalized | all four crosses reached Finalized | PASS | — | A performed 17 actions, B 1, C 0 |
| orders-closed | every order account is closed (rent returned) and ordersOpen is 0 on all four crosses | PASS | — | 9 orders, 0 still open |
| launch-clear | launch printed at the reference price and volume | PASS | — | P* 1200000 (ref 1200000), matched 2000000000 (ref 2000000000) |
| launch-buyer-0 | buyer 0 received exactly the reference fill and paid exactly fill × P* | PASS | — | base 1500000000 (ref 1500000000), paid 1800000000 (ref 1800000000) |
| launch-buyer-1 | buyer 1 received exactly the reference fill and paid exactly fill × P* | PASS | — | base 500000000 (ref 500000000), paid 600000000 (ref 600000000) |
| launch-buyer-2 | buyer 2 received exactly the reference fill and paid exactly fill × P* | PASS | — | base 0 (ref 0), paid 0 (ref 0) |
| launch-supply | launch base supply equals the matched volume and the mint authority is revoked | PASS | — | supply 2000000000, authority None |
| sealed-clear | sealed cross cleared to the reference with the unrevealed bid excluded | PASS | — | P* 1300000 (ref 1300000), matched 80000000 (ref 80000000) |
| sealed-buyer | the revealed buyer received exactly the reference fill and paid fill × P* | PASS | — | base 80000000 (ref 80000000), paid 104000000 |
| sealed-refund | the bidder who never revealed was refunded in full, to the atom | PASS | — | net change in quote 0, base 0 |
| noprint-state | the no-print cross ended NoPrint (volume below the minimum) | PASS | — | reason BelowMinimumVolume |
| noprint-refund | no-print: buyer and seller both refunded in full | PASS | — | buyer net quote 0, seller base 1000000000 |
| deferred-abandon | deferred launch: the settler never bound, the keepers waited, abandoned it after the deadline and refunded the buyer in full | PASS | — | reason SettlementExpired, buyer net quote 0 |
| conservation-quote | quote is conserved: owners + creator + fee recipient hold exactly what was minted, and every quote vault is empty | PASS | — | total 91000000000 (minted 91000000000), vaults 0 |
| conservation-base | sealed-cross base is conserved between seller, buyer and the creator's proceeds account | PASS | — | total 1000000000 |
| idempotent-idle | after Finalized, all three keepers ran about ten passes each and performed zero actions | PASS | — | A +0, B +0, C +0 actions in 60 s (143 s since the last cross finalized) |
| dup-claim | claiming an already-claimed order again is refused | PASS | — | SolanaError: Transaction simulation failed |
| dup-finalize | finalizing an already-finalized cross again is refused | PASS | — | SolanaError: Transaction simulation failed |
| both-keepers-worked | at least two keepers landed transactions on these crosses (the race was real, not one keeper doing everything) | PASS | — | landed transactions on these crosses: keeper A 21, keeper B 2, keeper C 0 |

## Transactions on the four crosses, by fee payer (from chain)

| Cross | Block time | Fee payer | Instruction | Result | Transaction |
|---|---|---|---|---|---|
| launch | 1791775816 | keeperA | — | ok | [2dXbJEMG…](https://explorer.solana.com/tx/2dXbJEMGF2jyWgZT5XQjxzdKPQHXpBpmeebyK4AgYj8r3VqcB9qL2zEuN5j2xrsBNk4qALzJYTHVegPfHGfkws7B?cluster=devnet) |
| launch | 1791775808 | keeperA | — | ok | [3MFMLA2Y…](https://explorer.solana.com/tx/3MFMLA2Y7JVcWoJWE82DkEqRuZw2oHoLaGPoHYjNZuVKs177A5GZBb9dY1ZxJTAqynGJRLvxWpnhsfUusVcjNJSw?cluster=devnet) |
| launch | 1791775799 | keeperA | — | ok | [3Bnh36oa…](https://explorer.solana.com/tx/3Bnh36oa2jfUdFtKhDxDG536iSFZoAoQ5LhdgpiFdy7263F7Y6TP3UTusDNvgHBHbue5YiJVyLXt4TrEXEZop7aw?cluster=devnet) |
| launch | 1791775797 | keeperA | — | ok | [ANsFUi6u…](https://explorer.solana.com/tx/ANsFUi6ubt3KosvZVt5tYd5tRRQyvzC5EbcoFHi9P7oXeUQV8veVm6bSYdssdePL8sevu96LR8BPRX2A63d9nUT?cluster=devnet) |
| launch | 1791775795 | keeperA | — | ok | [2MaE1HV2…](https://explorer.solana.com/tx/2MaE1HV2vrpV98PWZLH6fjsGxracqsDFAd3SYcWiyvnDqiTpzYBjdgehWtwxM4i7KHarQcbig7aEXwSKQbzmT4Ez?cluster=devnet) |
| launch | 1791775793 | keeperA | — | ok | [4usj9HzE…](https://explorer.solana.com/tx/4usj9HzERkSEAWBrDDMdYjpsnXxYtAMkiv878UbBpDWfVeo6cgqVYZJ7kSRc2QTdmiSLCXXuQas1QboqWEH8KffK?cluster=devnet) |
| launch | 1791775791 | keeperA | — | ok | [5UuqvFAv…](https://explorer.solana.com/tx/5UuqvFAvioZYzZ4CKVycp91xr7bZhyoJaEJCvkHGt5D3vkEKMYPuK25YCqWTTHcXTe5rLRoGVs4n8sWF75Txa2Tc?cluster=devnet) |
| launch | 1791775175 | t1 | — | ok | [5yAKgmmx…](https://explorer.solana.com/tx/5yAKgmmxvkcS9sQfydxFsBXFvAiVZRLH2CGhtBq1XBKrkGjBKtow4GjFwxu2nHpyCRVPmVrMMqVuEBvyHuCHACF8?cluster=devnet) |
| launch | 1791775175 | t2 | — | ok | [qifvdYvy…](https://explorer.solana.com/tx/qifvdYvyxgwLzyusvFTmLQcqYC1iJBwyLCFPK5qYZAihy9whVYEaY9t1gGQpzTA8qSTjvtbfAiQKxpYs3EExZiw?cluster=devnet) |
| launch | 1791775175 | t0 | — | ok | [4BaGfjQi…](https://explorer.solana.com/tx/4BaGfjQiH1oQgDEYLMQUfUgbhELKc2e8rWXpkBG8t7Mv5Nm6JcwPgsffYEPWYcdqYsT2HfK8DAjttKJMEaLJ7pNB?cluster=devnet) |
| launch | 1791775167 | creator | — | ok | [4kJDswrS…](https://explorer.solana.com/tx/4kJDswrS2QWTtrsN4nR9wAy9fp27tNj11TkJZbTKJdsUbP4ER5mE9TUTZ4Y6aG467hvbJHj19NmqQwWcgTVDDcXt?cluster=devnet) |
| launch | 1791775144 | creator | — | ok | [2hw66Xpm…](https://explorer.solana.com/tx/2hw66XpmkDuLrD49JzbNd17gGXvDPNqSzzMJ4mD2k7ynphYBCXps5qTjZtS4hkd2hjvj7uvMeZWQS8ZJi7PD1BAV?cluster=devnet) |
| launch | 1791775127 | creator | — | ok | [4mv1bx5k…](https://explorer.solana.com/tx/4mv1bx5kZYFQ7fpcrozHM2XiKUPxF8fYhEsVRX2ezr5sKDBPKsExLnvYxjPiigf945h9zM6chJpXX5ifC2FiKAuR?cluster=devnet) |
| sealed | 1791776072 | keeperA | — | ok | [3DbYNqzS…](https://explorer.solana.com/tx/3DbYNqzSzNdCfJ766M227ZSow2ykvxJA6WtEARG3p2FFRPc4jJGTXBS4YQ41opaCQU4DXUpurorzfjrnPKpPhQBB?cluster=devnet) |
| sealed | 1791776070 | keeperA | — | ok | [K7coixsy…](https://explorer.solana.com/tx/K7coixsytW1nz43bRYZaciY9uMNNHHX9pcCyNMgyswK56AkXYLqiTS77j2P5pheujCT276hbSXEnqKHRrcX1jK9?cluster=devnet) |
| sealed | 1791776068 | keeperA | — | ok | [pEKaq8hE…](https://explorer.solana.com/tx/pEKaq8hEh5AFK2TbXFTWzTbPQhuGGCAKsd4rQcvwqbFKUkdR26kTs9kZwY8X55u6DaJgqtHeLYuczWRb7jbFsXd?cluster=devnet) |
| sealed | 1791776044 | keeperA | — | ok | [3ADyyeu9…](https://explorer.solana.com/tx/3ADyyeu925MiPDN9jELhjMaYb8xCcpjcfHe9KtJEDTCYgmf4SRtSey7qV3S6hqbJx6NeXmUg2bGRCXmPgdcLG8hQ?cluster=devnet) |
| sealed | 1791776040 | keeperA | — | ok | [5MYUTjMQ…](https://explorer.solana.com/tx/5MYUTjMQbn1atPrmSMVyKxcXEtpi5SA79aM74ewSznvweHoMdnNdbaAoCU5PU3hqgK2NHebYGqo68VRb6XWghzn6?cluster=devnet) |
| sealed | 1791776039 | keeperA | — | ok | [5yoHbFBM…](https://explorer.solana.com/tx/5yoHbFBMEkeAnmmYGALFWggG9zGwuxwcopyx1dMu42euEYHQMqYcWeBQvaieetKzkoGbihQTrAo6MjPJMAc7ZC13?cluster=devnet) |
| sealed | 1791775740 | t3 | — | ok | [4yicvPii…](https://explorer.solana.com/tx/4yicvPii7pgboZduN4t8eQKZ2oVVnBTjdcRbEDKFNQXsZXSPpXYXV4j47Tr7jc4MnMXHxHEzSTuCJdAGxnodD2hx?cluster=devnet) |
| sealed | 1791775738 | t4 | — | ok | [54mtBLAk…](https://explorer.solana.com/tx/54mtBLAkh7f2TzxsksymUKzM7XsjLPnbb47JKoX8EQwH4KhJHKPSNWLedN6ooQBUgWTdEaAA7EgJTSWKqAmVJBa5?cluster=devnet) |
| sealed | 1791775175 | t5 | — | ok | [2ARgv2Gh…](https://explorer.solana.com/tx/2ARgv2Gh8fHK3iHHMzZRHWWPrURZuYF5mAMNZKEvU9R2b76R6pCTeSZSg5A49X59JDnQKDjGzYFyidFH42BBNoS6?cluster=devnet) |
| sealed | 1791775175 | t3 | — | ok | [2DdhicGM…](https://explorer.solana.com/tx/2DdhicGMkpr1iodUpr7Es8oh66Z4GnHeZ579VC257DVGpJ8fv7P6vJPLcUhonjDiV67p13P4SAghNm4nu8JfoDBW?cluster=devnet) |
| sealed | 1791775175 | t4 | — | ok | [45BXVuiM…](https://explorer.solana.com/tx/45BXVuiMspF7ott7kL8xvFFSwM2eeQf7RfYbFRvSEjXBbWYPKr93MPZ2A1WeW1L9y1dkYGAHc5sZSBqChASLTmb2?cluster=devnet) |
| sealed | 1791775144 | creator | — | ok | [2nctPVxa…](https://explorer.solana.com/tx/2nctPVxarg6GisXminFAewKHGUCLrsDiosuUD4t4YVQfmRxncSY6Yggq86CPPmNbRv5UwQuFTAdjakieWcnDQ6f6?cluster=devnet) |
| sealed | 1791775127 | creator | — | ok | [eynGPYnF…](https://explorer.solana.com/tx/eynGPYnFoM6qw2q4XoUNVCgQsDpR6UwE3WePGb5eiN528Xcqc2k7dc6EHoK2hTXHsQRbg4kEhqP7URFB4cK9BH3?cluster=devnet) |
| no-print | 1791775851 | keeperA | — | ok | [58voaCkF…](https://explorer.solana.com/tx/58voaCkF794fyJBZvuuJvpEdguxztZ2p7s9s9dKYZwmBcSHtdRTrKZpV8AAbmWfgYhJqX2a5Nu8cRwjyqziVYdx4?cluster=devnet) |
| no-print | 1791775835 | keeperA | — | ok | [2rSEb3tw…](https://explorer.solana.com/tx/2rSEb3twefLL37Cr5XXN5Rjwv8uVJcY7EqXoVEdapNgJGzTJhnkCx8WFANLMwGUmKfABuYJTBTiiCR8xYL6jx3Ex?cluster=devnet) |
| no-print | 1791775825 | keeperA | — | ok | [4Kt6ot6h…](https://explorer.solana.com/tx/4Kt6ot6hmFKyxC1GYMjLa1gjz8Lw65jG7iB6HkW1J3Ss7zq5Skv9cL4bypeF6GXiDGgzbzhWF37uLoiGUwwt3eW7?cluster=devnet) |
| no-print | 1791775822 | keeperA | — | ok | [3mkegqA5…](https://explorer.solana.com/tx/3mkegqA5rZG9E1NxYt2666ioHQPv38xGzxGgyt8gHqhZ6XSei6EcZeGBvbC4D46wbos1nPgWCBSQWcyyLwkQEjHh?cluster=devnet) |
| no-print | 1791775820 | keeperA | — | ok | [FMCKdzy7…](https://explorer.solana.com/tx/FMCKdzy7Cd41MkWW1sttWiAin9YLqd955dryRYJiLiJm9VTXAPair9j1vr3RjwA8DKeujBAXqYkZqef4dumoLVN?cluster=devnet) |
| no-print | 1791775175 | t7 | — | ok | [51TSHc5j…](https://explorer.solana.com/tx/51TSHc5jefjX3dFVk7jkrvuXSBb3XC7ork7Nr69AXchJgLSfWxuh6o9ALCmiygAnSNDyinoKADM6G5FTsisAcNCD?cluster=devnet) |
| no-print | 1791775175 | t6 | — | ok | [2kJfsAga…](https://explorer.solana.com/tx/2kJfsAgawd9vjLJkJBrPFYeLrQPoPwVxycKVjFJ8wy5bff7crkpXcc6BhGa6KFayDPvZH17yEpb1S2NmN7oHEE7N?cluster=devnet) |
| no-print | 1791775144 | creator | — | ok | [5MSigpAJ…](https://explorer.solana.com/tx/5MSigpAJk66NmxiLc65DToKgDqGTYuEKTTSzYE5WDQ1b9K7xsKiVccG1yLk6YDEsJdLAwxktWmTQYb5haSF62wLe?cluster=devnet) |
| no-print | 1791775127 | creator | — | ok | [9pYv4gPS…](https://explorer.solana.com/tx/9pYv4gPSLLPtLXfG3EuQZPjRTrJFiwHDfLmnNDADTjngqgydeQXtEnyTcj84Qz7Ky6ZJyWjitiyrpRVK2MbNBLo?cluster=devnet) |
| deferred | 1791776123 | keeperA | — | ok | [2t6Bwq8S…](https://explorer.solana.com/tx/2t6Bwq8SkThXhN7VNbfUNNP2JBzYb9PzseWvPpF5mdHKAkRjLa84oNZosT7tbJJP4zhgQwHjB9bByd4zxcH9aoWW?cluster=devnet) |
| deferred | 1791776114 | keeperA | — | ok | [rK3FzeWk…](https://explorer.solana.com/tx/rK3FzeWkbF6WXE9XvckWjy9fzzdaVhdAxMm3gaw4rnfCDzeAHCuSxHEuZHZh4jL6BpTa7oAPvdq7HdTcPfpJpYC?cluster=devnet) |
| deferred | 1791776107 | keeperA | — | ok | [66ETopVC…](https://explorer.solana.com/tx/66ETopVCC5YQDVoBqyUkBRYRWubpL4FyMwvzGTHb58cwtJM7cUTv4WXkKBAEvYaBnQsT8LWtX6SL1AMSFWwaTvo5?cluster=devnet) |
| deferred | 1791775763 | keeperB | — | ok | [3XzGuWnc…](https://explorer.solana.com/tx/3XzGuWncJ9u7yDiLJZ5kaGcmr9y32XScdj9oaSkgkfWFoPmsqwdwdjSx5Vf4Vkc5s895zigmKLBhBPSfzoGhnpM1?cluster=devnet) |
| deferred | 1791775761 | keeperB | — | ok | [tmVXaydy…](https://explorer.solana.com/tx/tmVXaydy3jGvsHUpqa8SxM7v8T6cBYa5d5kFLinrJmax9DrKPqPEt8t6xnxUFs9iJvx2AwcjsvXcgpdanJVMqcP?cluster=devnet) |
| deferred | 1791775175 | t8 | — | ok | [iN7rXHnK…](https://explorer.solana.com/tx/iN7rXHnKbVKQhzHbZxnmfXNPQT6h8W8QxgJiHdyNTGkhoAfC9hxRw2JxYNCi1uwUXFSJxitnQLa3qdxtbzNUV5A?cluster=devnet) |
| deferred | 1791775146 | creator | — | ok | [2h799n2v…](https://explorer.solana.com/tx/2h799n2vcKDxikC8QExvinYn5RPXhzANTBA8MEAtZoWzErYF9WQB11AtnRs9eYKtt4Y6mWk7esz4echWBVdkmq6F?cluster=devnet) |
| deferred | 1791775126 | creator | — | ok | [51P8qpDD…](https://explorer.solana.com/tx/51P8qpDD4DDjk129jGbUDNjm3LXywP93yhPDp9khs81To34YX8MKoGCmiugmarPxtvQwMvD2wEMvcjYc19HJM5nT?cluster=devnet) |

Landed-but-failed transactions touching these crosses: none.

## What the losing side of each race looked like (keeper logs)

- no refused actions were logged

## Keeper pass errors (RPC, discovery)

- none

## Crosses

- launch: `5UfrmxAv1qQakpSp8fJ8yD2Jx3nekb4nu8HjsF2wA8Wm`
- sealed: `6NrhAQBEmcWgPcceCZMZ7tpJiy1BdvyXnAWJn7KwGRGt`
- no-print: `JAspknVztN62MdAQcYJ1S79UEfDrSkzPZud8egAHijtF`
- deferred: `EMmoeu8LYuFvDmiTYxbHaBZetUTHxsAABzs3jZ3Htg8H`

## What this run covers, and what it does not

- Covered, on the deployed devnet programs with the real `services/keeper` process: sealed cross with an unrevealed bid, an open-book mint-mode launch that prints, a no-print (volume below the minimum), a deferred-mint launch whose settler never binds (waited, then abandoned after the deadline, refunded); merge, clear, claim (fill and refund), finalize; three keepers with three payers, one via the indexer and two via `getProgramAccounts`, one SIGKILLed after landing work and restarted; a third party claiming an order under the keepers; duplicate claim and duplicate finalize refused; conservation of quote across owners, creator, fee recipient and vaults, and of the sealed cross's base.
- Keeper C landed nothing: keeper A (indexer discovery) and keeper B won every race. The race is real (A 21, B 2 landed transactions, zero landed failures) but it is not a three-way split.
- Not covered on devnet: calendar-triggered crosses, an oracle-guarded cross (the keeper reports it as refused without a Pyth update; LiteSVM covers it), a crowded book (the crosses hold 1–3 orders each; concurrency at 80 bids is `latency-proof.ts`), and the refusal logs of the losing keepers (only a keeper that completes a pass writes its log, so the SIGKILLed keeper's last pass is visible on chain but not in its log).

## What broke on the way, and the fix

- **The keeper confirmed over a WebSocket.** Public devnet drops WebSocket connections: keepers logged `WebSocket failed to connect` after sending, so a landed step was reported as failed. `services/keeper/src/send.ts` lands transactions over HTTP only (preflighted first send, re-broadcast, rebuild on blockhash expiry, tolerance of a node that has not seen the blockhash yet); `WS_URL` is no longer needed. Tests: `tests/core/test/keeper.test.ts` (3 new, with an RPC double).
- **A keeper served every cross it could see.** On a shared cluster it settled and claimed other jobs' crosses. `KEEPER_CREATORS` (comma-separated) now scopes a keeper to some issuers, pushed down into discovery (a `creator = ANY($1)` query for the indexer, a memcmp at offset 8 for `getProgramAccounts`) and enforced again on the decoded account. Test: `keeper.test.ts` (scoped keeper leaves a cross alone; the creator's keeper finishes it).
- **The reconciler raised false drift.** The indexer follows finalized transactions and the reconciler read finalized accounts a moment later, so any cross that moved in between produced alerts and `/v1/health` returned 503 for an hour (15 alerts on three crosses in the first minutes of this run, all lag). `reconcileSettled` catches up and compares again, and records only drift that survives; `services/indexer/src/reconcile-cli.ts` is a one-shot version. Test: `tests/core/test/indexer.test.ts` (lag is not recorded; a lost event still is).
- Harness defects, not product defects: a first run measured buyers' payments against a balance taken after escrow (negative "payments"); a reveal window of 120 s was shorter than devnet's worst landing delays under 429 throttling (now 300 s); aborted attempts left unrelated crosses under the same creator (each run now has a fresh creator).
- Earlier attempts of this fork's run (five in total) were stopped by harness defects and RPC throttling (HTTP 429 from the shared public endpoint); the on-chain outcomes of the second attempt already matched the reference. The figures above are from the last, complete run.
