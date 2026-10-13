# ADR-0313: Pay-per-call sells a service on top of free data, validates before it charges, and answers 501 when it is not configured

Status: accepted (2026-10-13) · Rows J1, X6, X11, P1, P3 to P5 · Code `services/api/src/routes/paid.ts`, `paid-config.ts`, `services/mcp/src/payment.ts` · Evidence `W2A-X6-x402-api.md`

## Decision

1. **Nothing paid is data the free API withholds.** Every fact is also at an unchanged free route. A payment buys a service: an independent recomputation signed by the published attestation key (`/v1/paid/verify/:cross`), one signed audit bundle (`/v1/paid/bundle/:cross`), and an agent's pre-trade check with the unsigned order transaction, the safety verdict and the cluster's simulation of it (`POST /v1/paid/order-desk`).
2. **A request that cannot be answered is a 4xx before any price is offered**, and the work runs before payment settles, so a failure charges nothing. A free preview of the same shape comes with every offer.
3. **Prices come from the rate card** and are proposals until HD1.
4. **The x402 `exact` scheme and the MPP charge intent** both work; the gate is keyed by a secret file and settles through a local facilitator whose fee payer sponsors the transaction. A half-configured gate stops the process; an unconfigured one makes the paid routes answer 501 with a pointer to the free route, so the API never pretends.
5. **Over MCP the payment travels in `_meta["x402/payment"]`** and the response in `_meta["x402/payment-response"]`, with a tool result carrying `isError` and `structuredContent` = the payment requirements (the coinbase x402 MCP transport as published, fetched and followed on 2026-10-13). Three paid tools wrap the three routes.
6. **A failed status poll while confirming is "not seen yet"**, not a failure: a rate-limited RPC must not make a settled payment look unpaid.
7. **Receipts and bundles are signed documents** (ADR-0318).

## Alternatives rejected

- Charging first and validating after: the careless-buyer case would be charged for an error.
- Selling data the free API serves: the market would price the free route and resent the paid one.

## Consequences

Enabling it needs a funded fee payer, a recipient token account and a secret (HUMAN_TASKS). MPP over the routes and settlement of non-zero fees on a real chain were not exercised.
