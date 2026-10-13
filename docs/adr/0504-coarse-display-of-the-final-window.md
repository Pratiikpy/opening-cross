# ADR-0504: The coarse display is a rule of our apps

Status: accepted (2026-10-14). Resolves the open item of ADR-0452 ("the coarse display is not wired into the API or apps").

## Context

ADR-0452 asks that the indicative price be delayed and the imbalance coarse during the ending period, so that a last-moment order cannot read exactly where the price is going. On an open book the order accounts are public: anyone can read every order from the chain.

## Decision

`GET /v1/crosses/:address/indicative` applies `coarseIndicative` (the price to the nearest of eight bands of the grid, the imbalance as `balanced`, `demand-heavy` or `supply-heavy`) while the ending period is open, and says in its `note` that this is the display rule of our apps and not secrecy. A cross that needs hidden books is sealed. The existing `GET /v1/crosses/:address/book` (a handler in `server.ts`) is unchanged and still shows the fine figures: screens must use the new route while its `phase` is `ending`. The MCP tool `oc_get_indicative_price` calls the new route.

The book itself was also wrong for a cross with an ending period: `loadBook` (router) and `readBookFromChain` (client) summed the main shards only, so the orders resting in the bucket shards were invisible. Both now include the bucket shards up to the last counted bucket (all of them until the draw) and the extension shards after an extension; a bucket shard that is not on chain holds no orders.

## Evidence

`services/api/test/rules-tx.test.ts`, `packages/client/test/rules-builder.test.ts` ("the book of a cross with an ending period").

Not covered: a browser render of the coarse view (the screens are built elsewhere), and a live cross with an ending (none exists on devnet).
