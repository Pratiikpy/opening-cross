# ADR-0322: Routed execution builds an unsigned transaction for the winner of a ranking and never signs

Status: accepted (2026-10-13) · Rows Z1, W9 · Code `services/api/src/routes/execute.ts`, `packages/router` · Evidence `W2A-Z1-router-execute.md`

## Decision

1. **`POST /v1/route/execute` ranks the venues for an order and returns the winner's unsigned transaction**, with the signers it needs and the limit it enforces. The API holds no user key.
2. **A gated or closed cross is refused with a 409 and nothing is built.** A venue that cannot fill the order is listed as excluded with the reason, and if none can the answer is a 422 that says why, not an invented transaction.
3. **Jupiter serves mainnet only, and the answer says so** on any other cluster (`excluded`). On mainnet the swap is built through the router package's Jupiter adapter; the builder was exercised against Jupiter's real API read-only, and the full path is covered by tests against a stand-in.
4. **An intent delegates nothing** (ADR-0314): `POST /v1/intents/:id/execute` matches it to the pair's live crosses now and answers like the route, with a transaction the owner signs.
4a. **A cross price is indicative until the call closes**, so the limit is a bound and not a promise: a buy limit is the indicative clearing price plus a number of grid steps (default 2), a sell limit minus the same, unless the caller names one.
5. **The cluster's own simulation can accompany the answer**, so a caller sees compute units and logs before it signs.

## Alternatives rejected

- A custodial router that signs: the API would hold keys.
- Returning the best price without checking the venue can take the order.

## Consequences

Execution against a live mainnet cross is untested because none exists. An empty body to the intent route crashed the first version (500) and is parsed leniently in its own scope now.
