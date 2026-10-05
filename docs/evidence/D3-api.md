# D3 — API evidence (2026-10-05)

`services/api` (Fastify 5.12.5, @fastify/websocket 11.3.3). Reads come from the indexer's tables
for lists and history; any account a user acts on is read from chain in the same request, and
only accounts owned by cross_core with the right discriminator are decoded. Writes are unsigned
transactions with the user as fee payer (`src/tx.ts`); the API holds no key and never sees a
sealed-bid salt except in the request that uses it. `/v1/stream` pushes every event the
indexer commits, via Postgres LISTEN/NOTIFY (`services/indexer/migrations/002_notify.sql`).

Routes: `GET /v1/health`, `/v1/crosses`, `/v1/crosses/:address`, `/v1/crosses/:address/orders`,
`/v1/crosses/:address/proof`, `/v1/orders/:address`, `/v1/owners/:owner/orders`, WS
`/v1/stream[?cross=]`; `POST /v1/tx/create-cross`, `place-order`, `cancel`, `reveal`, `settle`,
`claim`, `finalize`.

## Contract test (`tests/core/test/api.test.ts`)
A sealed cross runs end to end through the API alone: create (3 transactions), two orders,
two reveals, a third party settles and cranks claims, finalize. Each returned transaction is
decoded, signed by the user's own key and landed on LiteSVM; the indexer ingests what landed.
Asserted: signer lists, chain state after each phase, the buyer's base balance, `proof.verified`,
order statuses and fills, the list filter, health, and the WebSocket delivering all nine events
in order. Refused without building a transaction: empty/array bodies, malformed and
out-of-range integers (−1, 2^64), unknown enum values, missing fields (named in the error),
non-addresses, missing accounts, non-cross accounts, a byte-for-byte forged cross owned by
another program, reused nonces, ordering on a settled cross, settling twice, claiming on a
finalized cross, sealed orders without a salt, oversized bodies (413), bad query parameters,
unknown routes, and a stream filter that is not an address.

Findings fixed while testing: the cross decoder accepted any account whose bytes parsed (now
owner + discriminator checked); a finalized cross was described as "not settled yet".

Full suite: 18 files, 90/90 passed, three consecutive runs (each DB test in its own schema).

Not covered: a hosted deployment and a devnet run of the API (devnet cross_core needs the
upgrade in HUMAN_TASKS H10). Rate limiting and auth for a public endpoint belong to the hosted
deployment and are tracked with launch (L-track).
