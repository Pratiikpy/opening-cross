# W2A-Z1, W9: router execution and signed intents, run on devnet

Rows: Z1 (open-execution router: the unsigned-transaction builder that routes an order to the cross), W9 (aggregator intents, off-chain part). Date: 2026-10-13. Code: `services/api/src/routes/execute.ts` (`registerExecute`), `packages/router` (`jupiterSwapTransaction`), `packages/liquidity` (`intent.ts`), tests `services/api/test/execute.test.ts` (7), `packages/router/test/jupiter-swap.test.ts` (3), run script `services/api/scripts/execute-devnet.ts`.

## Jupiter is mainnet only, and the answer says so

Jupiter routes mainnet liquidity. On any other cluster the route returns the ranking with `jupiter: Jupiter routes mainnet liquidity only; this API follows devnet, so there is no DEX route for these mints.` under `excluded`, and the only venue that can win is a cross. On mainnet the same call quotes Jupiter through the router package and, when Jupiter is cheaper, builds its swap transaction. That path is not exercised against a live Opening Cross on mainnet (there is none): it is covered by tests against a stand-in for Jupiter's HTTP API, and the swap builder was called once against Jupiter's real public API on 2026-10-13 (read-only, no funds): a buy of 0.1 SOL for USDC returned a 928-character unsigned transaction, last valid block height 434534760, quote in 10,687,959 USDC atoms, route Raydium CLMM, price impact 0.0000069%. Meteora pools are not priced; they are listed as excluded with Jupiter's route plan as the way they would be used.

## The devnet run

The route module ran on a local port with a scratch Postgres, reading devnet through the public RPC. The wallet is the market-maker run's taker `ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm`. The venue is the live cross `FFQqs2za6q6EYfqiuA1MHToARBJL5NTuFSZT53vFjKyM`, where the bot (`W2A-X6-marketmaker.md`) had placed a bid at 1.45 and an ask for 200 tokens at 1.55.

| Step | Result |
|---|---|
| `POST /v1/route/execute` buy 20 tokens | 200, venue `cross`. The cross's indicative clearing price for this order is 1550000; the limit is that plus two grid steps, 1650000, and the response says how it was chosen. Escrow 33,000,000 quote atoms. The cluster's simulation of the unsigned transaction: no error, 21,765 compute units. Ranking: the cross full fill at 1550000 per token; Jupiter excluded (mainnet only); Meteora excluded. |
| Wallet signs and sends | Signatures `2kf263jo1BtSz6RZNtBiyLhFAdGjRBvjna89RynFPfDzRuGpw5fYAwmzkMtFpouor6ZW7Z3zSscWB8bJUrbxpRbr` (this was the first run of the script; the second and third runs sent `67MCV85mQhrMr6eGJrX2vc2zdFG67XYq7w4YNEgtLqZ3bBYR4nSmuZD9E3sc19k24yTG86tAmU8ALp9kjZtdnyEG`, `3iptZpSVKtnzzMnkAKhX3f4xn1esc4BWyahRXa57sMj3kgGRemgrKMkzfCqRQn9Xh7e2fDsZFvuW8nCpvS5XiD4X` as well; the intent step failed in the first two runs on the defect described below). |
| `POST /v1/intents` with the wallet's signed intent "buy 10 tokens of this pair at no more than 1.70, valid 30 minutes" | 201, stored. The same intent with its quantity edited to 99 tokens: 400, refused (the id no longer matches the body). |
| `POST /v1/intents/:id/execute` | 200, venue `cross`, limit 1700000 "the limit you named", escrow 17,000,000. Signed and sent: `5gZ9ogqMxaUNjbiWF4XirNsoqHD212ZMTDPtQkWPMGy6Vn5wG8mqF5qQRFhEfbSGpwusQRexw4cBFVutYxYxtoM1`. |
| Chain, afterwards | The deployed API's book of the cross (`GET /v1/crosses/FFQq.../book`, read from the cross's shards): 273,511,465 bid at 1.45 (the bot); at 1.55 a 1,000,000 bid (the Blink order) and the bot's 200,000,000 ask; 60,000,000 at 1.65 in three orders (the three routed runs of the script); 10,000,000 at 1.70 (the intent). Seven orders, and an indicative price of 1550000 for 71,000,000. (The cross detail's own `orders.total` printed 5 in the same run because the API serves a cross read for up to a minute when the endpoint is slow; the book is the fresh read.) |

A defect found by this run and fixed: an HTTP client that sends `Content-Type: application/json` with an empty body to `POST /v1/intents/:id/execute` got a 500 (`FST_ERR_CTP_EMPTY_JSON_BODY`). Inside that route's own scope an empty JSON body is now no body, and invalid JSON is a 400. Covered by a test.

## What an intent is, and is not

An intent is a signed, expiring instruction (`opening-cross/intent/v1`, Ed25519 over a domain-separated hash of the canonical body). It lets a router hold the instruction, prove who gave it and when it lapses, and answer it with an unsigned transaction when a suitable cross is open. It is not a delegation: `cross_core` has no instruction that lets a third party place an order for a wallet, so the owner signs every transaction. Delegated standing orders (a mandate that a keeper can execute) need a program and belong to the programs workstream.

## Not covered

Mainnet Jupiter execution in an Opening Cross flow; a sealed cross through an intent (the route explains why it is skipped and `POST /v1/route/execute` takes a named cross, a limit and a salt instead; covered by tests only); a limit-sell routed order sent on devnet (covered by tests); a wallet balance check before building (the simulation reports an unfunded wallet as an error instead); the deployed stack, which does not carry these routes until `registerExecute` is wired into `services/api/src/server.ts`.
