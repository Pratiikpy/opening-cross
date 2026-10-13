# ADR-0408: The coarse final window, and an order price read from the chain

Status: accepted (2026-10-13)

Row S1

## Context

Two gaps in the live price-discovery view: nothing coarse in the final minutes, and the price of a just-placed order is unknown to the chart for about a minute.

## Decision

- Final window (display only): in the last quarter of an open call, never more than ten minutes, the hero shows a price range of whole price steps (about an eighth of the grid) instead of the exact indicative price and a five-bucket description of demand against supply. The exact figures are one press away. The program has no hidden or coarse window and the page says so.
- Order terms: an open order's price is an argument of its `commit_order` instruction, not stored in the account. `GET /v1/orders/:address/terms` reads the order's first transaction from the cluster and decodes it with the indexer's own decoder, so the chart marks a wallet's order without waiting for the indexer. A sealed order has none until revealed.

Not done: random end, a cancel cutoff, coarse buckets inside the chart (those are program changes B14).
