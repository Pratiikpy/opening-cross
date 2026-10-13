# W2A-X6, S10: Blinks (Solana Actions), run on devnet

Rows: X6 (Blinks and wallet cross entry), S10 (trade from a link). Date: 2026-10-13. Code: `services/api/src/routes/blinks.ts` (`registerBlinks`), tests `services/api/test/blinks.test.ts` (8 tests), run script `services/api/scripts/blinks-devnet.ts`. The specification followed is the Solana Actions page (https://solana.com/docs/advanced/actions), read on 2026-10-13: the GET response (`type`, `icon`, `title`, `description`, `label`, `disabled`, `error`, `links.actions[].parameters`), the POST request `{ account }`, the POST response `{ transaction, message }`, the error form `{ message }`, the required `OPTIONS` headers and `actions.json` rules.

## What a Blink client does, run end to end

The route module ran on a local port reading devnet. A client with the wallet of the market-maker run's taker (`ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm`) did exactly what a Blink client does:

1. `GET /v1/blinks/cross/FFQqs2za6q6EYfqiuA1MHToARBJL5NTuFSZT53vFjKyM` (a live open-book reopen cross on devnet): `type: action`, title "Opening Bell: a call auction", label "Bid", the description "It closes in 1h 47m 18s. Prices run from 1 to 3 per token on a grid. Every filled order pays the same clearing price, never above your limit; whatever you do not spend comes back. If too little crosses, everyone is refunded in full. Anyone can recompute the result.", and four linked actions: Buy 1, Buy 10, Buy 100 (each with a `price` field) and Place order (side, price, quantity).
2. `POST .../order?side=buy&price=1.55&quantity=1` with `{"account": "<wallet>"}`: 200, an unsigned transaction (728 base64 characters) and the message "Bid for 1 token at up to 1.55 each. 1.55 leaves your wallet now and is held by the cross; you pay the clearing price for what fills and the rest comes back. No fee for buyers." (the run printed "1 tokens"; the plural was corrected afterwards and is covered by a test).
3. The client signed with only that account and sent: signature `3gyNCMQ4bMrGTfP4rmgLrbVuZCKAifwHkRBrdPqG2fzevuv9T1KuetXAjjnkwnG9dCTbPcFBhQHtNjrfY4mUMQFE`.
4. Read back: the cross account on chain reported 1 order, 1 open; the deployed API's index (`GET /v1/owners/<wallet>/orders`) showed the order: side buy, price 1550000, quantity 1000000, status revealed, escrow 1550000.

## Covered by the tests

Every endpoint answers `OPTIONS` with `Access-Control-Allow-Origin: *`, methods `GET,POST,PUT,OPTIONS` and the required headers. `actions.json` maps `/crosses/*` to `/v1/blinks/cross/*`. A closed, settled, not-yet-open, sealed or gated cross is returned as a disabled button with the reason (a sealed bid needs a secret that only the signer may keep, and a gated cross needs a pass), never as a button that fails later. POST refuses, with a sentence a person can act on and an `ActionError` body: no account, a bad account, a closed or upcoming call, a sealed or gated one, an unknown side, a price off the grid (the message names the grid), a zero or over-precise amount. The returned transaction is decoded in the test: its fee payer is the account, no signature slot is filled, and only one account is a signer, so no one but the wallet can sign it. A repeated click gives a different nonce, so it is a second order and not a clash.

## Not covered

- A real Blink client (Dialect, a wallet extension, X) has not rendered these endpoints. `actions.json` must be served from the root of the web app's domain for a link to `/crosses/<address>` to unfurl; this API serves its own copy at its own root, which covers links to the API's origin. Adding `public/actions.json` to `apps/web` (same rules) is a web change, HUMAN_TASKS H30. Testing the unfurl in dial.to is a manual step (HUMAN_TASKS H28).
- Sealed crosses: a Blink cannot bid in one by design (see above); the app is the path.
- Sell orders were not sent on devnet from a Blink (the sell message and transaction are covered by the tests).
- Action identity and attribution (the spec's `identity` accounts) are not used.
