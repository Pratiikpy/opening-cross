# W2A-W15: reference integrations (reopen, halt-resume, tender, block-sale, aggregator, quote publisher)

Row: W15. Date: 2026-10-13. Code: `examples/adapters` (package `@opening-cross/example-adapters`, one line added to `pnpm-workspace.yaml` so it can import the workspace packages). Tests: 15 (`examples/adapters/test/adapters.test.ts`).

## What each one is

Each adapter is an integrator: a program outside Opening Cross that decides when and how to open a cross for its market. It plans from live facts (a pure function, tested), prints what it would do and why, and then either asks the cluster to simulate the transactions (`--shadow`, the default: "shadow mode first") or signs and sends them (`--send`, needs `--keypair`). Token programs and decimals are read from the chain; the reference price defaults to the pair's last printed price from the API.

| Adapter | Plans | Refuses or waits when |
|---|---|---|
| `reopen` | A `reopen` cross that closes before the market trades again (settle and reveal time both fit), on a grid centred on the reference with the reference on the grid, minimum matched volume and an imbalance guard; optional oracle guard and calendar | the session is too close for a call, the clear and the reveal |
| `halt-resume` | After a halt lifts, a short sealed call on a grid twice as wide ("trading always resumes through a cross") | the token is halted or has a blocking property, was never halted, or the pair never printed |
| `tender` | A sealed, gated offer to named holders with a floor price, a minimum fill and a minimum window; prints the Merkle root the gate needs | no acknowledgement that the legal questions were asked (HS4), an empty or repeating holder list, a window under the floor |
| `block-sale` | A sealed sale with the reserve as the lowest grid price and a minimum fill; the unsigned create transaction for a multisig (Squads) to approve, then the sell order | a zero block or reserve, a ceiling not above the reserve |
| `aggregator` | The ranked quote and then the winner's unsigned transaction (`GET /v1/router/quote`, `POST /v1/route/execute`) | no venue can fill: it says why instead of inventing a transaction |
| `rfq-maker` | A signed quote pointing at a resting order, posted to `POST /v1/liquidity/quotes` | the API verifies and stores it only while the order rests on chain as quoted |

## Run on devnet, in shadow mode, through the live API

Mints `9YqqWuba...` (base) and `3p4zaqbp...` (quote), reference 1.55 (the last printed price of the pair, read from the API):

- `reopen --session-in 7200 --sealed --shadow`: closes 600 seconds before the reopen, orders accepted for an hour, a grid of 41 prices from 1.395 to 1.705 centred on 1.55, and the cluster's simulation of the create transaction: **would succeed, 51,142 compute units**. The four shard transactions cannot be simulated before the cross exists; they are reported as inconclusive, not failed.
- `halt-resume --was-halted --shadow` (the token is not halted now, so the adapter plans the resume as asked): a ten-minute sealed call on a grid from 1.24 to 1.86, create simulates fine.
- `tender ... --ack-not-legal-advice --window-secs 3600 --shadow` with three holders: floor 1.40, 41 prices in steps of 0.015, minimum fill 50%, gate root `7c2598cec06522c132f403e4d3785cacd697549d82211b20523c84abb24b433d`, create **would succeed, 54,100 compute units**. Without the acknowledgement flag it prints the HS4 sentence and exits 1.
- `block-sale ... --squads`: prints the unsigned create transaction (base64, the vault as the only signer) and the sell order to place after it.

## Not covered

No adapter ran with `--send` for this evidence; the send path is the same `signSendConfirm` the market-maker and Blink runs used (`W2A-X6-marketmaker.md`, `W2A-X6-blinks.md`). The Squads steps (propose, approve, execute) are a multisig's, and no Squads vault was used. The reopen adapter was not bound to a real exchange calendar or an oracle feed (devnet has no stock-token feed; HUMAN_TASKS H11). The aggregator and the quote publisher need the deployed API to carry the new routes (`registerExecute`, `registerLiquidity`); they are tested here against stand-ins and, for the routes, in `W2A-Z1-router-execute.md`. A tender's legal minimum window is a floor set by counsel per offering (HS4); the default seven days is a placeholder for a rehearsal. The Genesis bucket adapter and the xStocks shadow-mode partner integration remain NOT VERIFIED and are not built.
