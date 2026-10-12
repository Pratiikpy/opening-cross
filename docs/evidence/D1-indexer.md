# D1 — Indexer evidence (2026-10-05)

`services/indexer`: cross_core events → Postgres (`events` append-only; `crosses`, `orders`
projections), RPC source at `finalized` with a per-transaction cursor, and a reconciler that
compares every indexed cross and order with chain accounts.

## Local (LiteSVM → Postgres 17)
`tests/core/test/indexer.test.ts`, run under WSL with `DATABASE_URL` set (CI runs a postgres:17
service): full sealed lifecycle (5 orders incl. one never revealed, one cancel, clear, claims,
finalize) projected exactly; the whole stream replayed applies 0 events; reconcile reports zero
drift; a simulated lost event is reported as 3 drift rows and alerts. Attribution: CPI events
accepted, the same payload from another program ignored, truncated/unbalanced logs refused.
Full suite: 16 files, 85/85 passed.

## Devnet (live history of F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ)
`services/indexer/scripts/devnet-check.ts` against https://api.devnet.solana.com:

```
{ "firstRun": 9, "secondRun": 0, "events": 9, "crosses": 2, "orders": 3, "cursor": "507686924", "drift": [] }
```

Finding: the public RPC answered the backfill with HTTP 429; the indexer now uses a retrying
transport (`src/rpc.ts`, exponential backoff on 429/5xx/connection resets).

Not covered: Yellowstone gRPC source (needs a provider endpoint, HUMAN_TASKS H7); the RPC poller
is the production fallback and is what ran above.

Caveat found during D2: the devnet crosses above were created by an older cross_core build whose
account layout predates the current one, so this run proves the RPC source, cursor and replay
path, not decoding of current-layout accounts on devnet. Resolved 2026-10-12: devnet `cross_core` was upgraded to the
current layout, and the indexer ran against crosses of every shape on devnet (`D2-keeper-devnet.md`, `D5-verifier-devnet-sweep.md`);
current-layout decoding is also covered by the LiteSVM test.
