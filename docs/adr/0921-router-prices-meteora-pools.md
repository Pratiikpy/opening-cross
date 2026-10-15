# ADR-0921: The router prices Meteora pools (Z1)

Status: accepted (2026-10-16). Supersedes the "Meteora is not priced" exclusion of `services/api/src/venues.ts`.

## Decision

`packages/router/src/pools.ts` takes a pool as a `PoolRef` (mints, open flag, an engine) and prices an order against it: a sell is an exact-input swap; a buy is the smallest quote input whose exact-input output covers the amount, found by search on the pool's own quote, so the figure is what the pool would do. `mergePoolsIntoRanking` adds pool rows to the ranking `GET /v1/router/quote` produces and orders it by the router's own rule (full fills first, better price, partials by size, deterministic ties). `withPools` adds the pool leg to a best-execution report; `bestExecution` is untouched, so nothing that reads it changes.

The router does not import the adapters: the engine is injected, which keeps its dependencies as they are and keeps account layouts out of it. `GET /v1/pools/route` (ADR-0924) wires the two.

## Partial fills

A constant-product pool never runs out; it asks a higher price. "All it can give" therefore needs a bound: a partial quote is the most the pool gives within 10% of its mid price (`PARTIAL_FILL_SLIPPAGE_BPS`). A pool that physically lacks the token (a buy beyond its reserve, a DLMM pair out of bins) is partial; a sell a pool accepts at an awful price is a full fill whose slippage shows.

## Not done here

`/v1/router/quote` itself still lists Meteora as excluded: `server.ts` and `venues.ts` are outside this change. `GET /v1/pools/route` is the same answer with pools priced.
