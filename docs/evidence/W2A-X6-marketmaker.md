# W2A-X6 and Y7: the market-maker bot, run on devnet through the live API

Rows: X6 (own reopen market-maker bot), Y7 (bot on its own budget, volume reported apart), W9 and W7 (off-chain parts: a maker that quotes two-sided limit orders from escrow). Date of the run: 2026-10-13. Cluster: Solana devnet. API: `https://98-87-59-136.sslip.io` (the deployed stack; the bot reads and builds transactions through it). Code: `services/marketmaker`, `packages/liquidity`.

## What ran

`services/marketmaker/scripts/devnet-run.ts` drives one complete reopen cross with the bot as the maker and a separate wallet as the outside taker. The bot code is the production loop (`MarketMaker.pass()` in `src/bot.ts`); the script only creates the test tokens and the cross, and places the taker's order.

| Step | Outcome |
|---|---|
| `setup` | Two Token-2022 test mints, `9YqqWubArnofUWPP5GsXYGrofeHXjQPHm7kL513gHKv7` (base) and `3p4zaqbp7EgV1pc1wf9aw7YseY5UrvibpmpX7n7AFXZE` (quote), 6 decimals. Maker wallet `HjSYwwj6byv2KbUGHucjxhs1UJWPmzud6fRkB5GZRa8k` holds 500 base and 1,000 quote; taker `ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm` holds 100 base and 500 quote. Keys are generated for the run under `.keys` (git-ignored); the issuer is the devnet operations key. |
| `create` | `opening-cross create`: a `reopen` kind, escrow supply, open-book cross, grid 1.00 to 3.00 in steps of 0.05, 7 minute window: `DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T`. |
| `bot` (pass 1) | The bot found the Live cross through `GET /v1/crosses?state=Live`, read it, took the operator's configured fair value 1.50 as the reference, and placed a two-sided ladder: two levels per side at 2% and 3% from the reference, snapped by the grid to one bid at 1.45 and one ask at 1.55. Escrow 396,591,625 quote atoms and 200,000,000 base atoms. Signatures `39SXEqL5iXGNmb6TfmeNKc5rA5Vi4pB7u1328ufPHptBKT58Cf82XpRxKkYbCFe7ncfwmNX2gfieQUaBBcw53Gpo` (bid) and `29v2W6VUj7xATFt7PAwS734D4rHU8XhVZBFYvN3hTu2s6iiNbp8EoqkZ25ynNUYpmzz2iP3dW7uXZBqUyPArsQph` (ask). Passes 2 and 3 placed nothing: it does not quote twice into a cross it already has orders in. |
| `taker buy 1.60 100` | The outside wallet bought 100 base at a limit of 1.60: `5P6D4uQ7Q8CdGDE7qzoGefHE7Q23tn6KnbJQM3vqcgmLTZD3k6FL7iuwWonuX4xqs1dkCcK9vqdwMPx8jWKXFzVS`. The book showed an indicative price 1.55 for 100. |
| `settle` | After the close, two settle transactions: `3XJQTPfyJwBftUqRpxnzmpfv7mKRDAxsinJdqoSsKJVY1KeT8J1rMsXFivZWCyW6XzjnCHvccAWL7iMSGWUXEw9V` and `57eoCvMQoj8FYHgFX5T41YRHz6LRQFXsRPias1qwFZAodkLqbCXaD6UH1wGbKxRJdNQdQ49KopxGKiQCmivBKHgg`. State Cleared at 1.55, 100 base traded, sell side rationed. |
| `bot` (claim) | The bot claimed both of its orders (signatures `5YLdSQkSicRV9nEUpdtPQHG2VyivM2qqQQ65AsA8ksbQwNJAd8jk9Yp7EYwGVxko1JcsWcL2rEHpoEwRihechWDt` for the ask, `4k8HubyJMRpB4XWqnDDf8wi3ZHvLLS7cdy6xpwVmwWpZEFdZ5XBNih3fb63wauwRTbKfBB7zfPzhKe4AuXJmduvp` for the bid). |
| `claim-taker`, `finalize` | The taker claimed (`4f2FQvEZiCCK6Q2hXZ5j7PAJR9pvceQbJ2ZX8sKPp4dBLhBrqFW2u73is5BBDrQ5uwkykThroCQjevYKmJ1sQTZm`); the issuer finalized: state Finalized (read from `GET /v1/crosses/...`). |

## Read from the source of truth

- Fairness proof from the live API (`GET /v1/crosses/DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T/proof`): `verified: true`; on chain and recomputed both price 1550000, matched 100000000, rationed `sell`.
- The bot's orders as the index holds them (`GET /v1/owners/HjSY.../orders`): the ask for 200,000,000 base at 1.55 filled 100,000,000 and paid 155,000,000 quote atoms; the bid at 1.45 filled 0 and returned its whole escrow of 396,591,625.
- Token balances on chain (`getTokenAccountsByOwner`, public devnet RPC) after the claims: maker base 400,000,000 (500 minus the 100 sold), maker quote 1,155,000,000 (1,000 plus the 155 earned). Both equal the arithmetic exactly: 500,000,000 - 200,000,000 (escrowed) + 100,000,000 (unsold, returned) = 400,000,000 and 1,000,000,000 - 396,591,625 + 396,591,625 + 155,000,000 = 1,155,000,000.
- Bot volume report (`MarketMaker.volume()`): 2 orders, 1 filled, quote out 551,591,625, base out 100,000,000, fees 0. The reopen fee is 0 bps here because the cross was created with no integrator fee.

## Covered and not covered

Covered by this run: discovery of a Live cross, reference choice (configured), ladder construction and grid snapping, escrow within budget, placement through the API with the client pipeline, no double quoting, claim of a fill and of a refund, volume report. Covered by `services/marketmaker/test/marketmaker.test.ts` (19 tests): the last-print and book references, no reference means no quote, creator allow list, launch kind left out, gated and closing crosses left alone, mint-mode crosses get bids only, the cap on crosses held, sealed crosses (salts derived from a secret, reveal from the state), a failure in one cross not stopping the others, dry-run remembers nothing, the mainnet refusal.

Not covered: a sealed cross on devnet (the sealed path is covered by the unit tests only), a reference taken from a printed price of an earlier cross (unit tested only), a fill on the bid side (this run's taker bought; the bid was refunded in full), more than one bot instance, a run longer than one cross. The bot has no inventory management beyond a per-cross budget, and no hedging: it can lose money, which is why it runs from its own budget.

## The company's own flow is labelled

The maker address above must be in `OWN_WALLETS` of the API so that `GET /v1/metrics/external-flow` leaves it out. `deploy/docker-compose.yml` now passes `OWN_WALLETS` from `deploy/.env` (Z4, Y7). The bot is not in the rebate pool: `GET /v1/liquidity/makers/:maker` reports `operatedByUs: true` and a zero rebate for any wallet in `OWN_WALLETS`.
