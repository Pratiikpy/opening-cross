# Trust layer on devnet — signed band, grade, anchor, indexer drift

Run: 2026-10-12T03:44:05.150Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/trust-devnet.ts` over the stack from `tests/devnet/run-stack.sh` (indexer, API, promiser on devnet) and the launch cross created by `keeper-chaos.ts`
API http://localhost:8080 (NETWORK=devnet), RPC https://api.devnet.solana.com

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| band-issued | the promiser signed a band for the open-book launch (served by the API under the published signer) | PASS | — | promise b7aba0407ad7a66e…, signer 4mQF2RHCZ1BGzxNSqwa5vcneXh3hGK3KG3m3BA63N2vH, point tick 2, status PROVISIONAL |
| band-before-close | the band was signed while the call was open (issuedAt before the chain close time) | PASS | — | issuedAt 1791775580, closeTs 1791775754 |
| stranger-verify | a stranger following the published instruction: the id and signature check out for the published signer, the published book hashes to inputsHash, the recomputed point equals the promised tick | PASS | — | PASS  id and signature are valid for 4mQF2RHCZ1BGzxNSqwa5vcneXh3hGK3KG3m3BA63N2vH / PASS  the published book hashes to inputsHash / PASS  recomputed point is tick 2, the promise says 2 |
| graded | the promiser graded the band against the cleared cross account | PASS | — | {"promiseId":"b7aba0407ad7a66e29f65c34cb033eb2d6b798f14526c440d44104be17226dd1","status":"SCORED","reason":null,"outcomeTick":2,"errorTicks":0,"intervalScoreTicks":null,"gradedAt":1791775810} · chain: P* 1200000, tick 2 |
| stranger-grade | the same published command with --rpc reads the outcome from the cross account on chain and reports the grade | PASS | — | GRADE SCORED: cleared at tick 2, error 0 ticks, claimed [2, 2] |
| track-record | the public track record counts the graded promise | PASS | — | {"issued":71,"crosses":22,"graded":48,"unresolved":8,"void":15} |
| anchor-inclusion | the Merkle inclusion proof for the promise verifies against the anchored root | PASS | — | root 9b9d2f063d58c16c…, 6 promise(s) in the anchor |
| anchor-on-chain | the Memo transaction on devnet carries exactly that root, was paid by the promiser, and its chain time bounds the promise from above | PASS | [5RJhA4bk…](https://explorer.solana.com/tx/5RJhA4bk2toMDMjZVFwNvtNjn4Y5FFYFZPDwkVbPANEnyqJsFcxJ22AdSr9WpzAP8uxJyW5c75mCeyy15SK39H4s?cluster=devnet) | tx 5RJhA4bk2toM…, memo "opening-cross/promises/v1 root=9b9d2f063d58c16c03155389260eb4fc89bf69bf0b5d6c1cbc72aa2b76ec80d7 n=6", fee payer 4mQF2RHCZ1BGzxNSqwa5vcneXh3hGK3KG3m3BA63N2vH, blockTime 1791775643, issuedAt 1791775580 |
| indexer-drift | the one-shot reconciler compares every indexed cross, order and counter with finalized chain state and finds zero drift | PASS | — | 48 crosses compared, drift 0 |
| api-health | the API health check reports no drift alerts in the last hour | PASS | — | {"ok":true,"indexedSlot":"510130007","recentDriftAlerts":0} |
| indexer-complete | every cross account owned by cross_core on devnet has a row in the index | PASS | — | chain 48 cross accounts, indexed 48, printed 33 |

## Not covered

- A calibrated band: the track record has not accumulated 30 graded crosses over two days, so the band is PROVISIONAL and claims no coverage; the grade is scored against the cleared tick, not counted as a hit or miss.
- The web pages against devnet (the browser flows are in `T-trust-e2e.md` against a local validator).
- The identity panel (the registry describes mainnet mints only).
- `/v1/health` was 503 before the reconciler fix: see `D2-keeper-devnet.md`.
