# ADR-0315: The event stream is typed, resumable from a cursor, and ordered by a total ingest order

Status: accepted (2026-10-13) · Rows L4, X16 · Code `services/stream`, `services/indexer/migrations/009_event_ingest_order.sql` · Evidence `W2A-L4-stream-backtester.md`

## Decision

1. **gRPC with a proto**, `opening_cross.v1.EventStream` (`Subscribe`, `Head`). Each of the program's events is its own message; amounts are `uint64` (matched volume, counted in 128 bits by the program, is a decimal string); enum values carry the names from the generated client, so a variant the program adds appears under its name.
2. **A client resumes from the cursor of the last event it handled.** The cursor is `events.ingest_id`, a total order assigned at ingestion (migration 009), idempotent, and backfilled in (slot, signature, sequence) order for existing rows. Ordering by slot alone is not total: events in one transaction and transactions in one slot need a tie-break that survives a rebuild.
3. **Errors are sent with `call.emit('error', { code, details })`**, not by destroying the call, so a client sees a status.
4. **Optional bearer token and TLS**; plaintext is for use behind a proxy that terminates TLS. The WebSocket feed is unchanged.

## Alternatives rejected

- Ordering by (slot, signature, seq) at read time: cannot be resumed with a single scalar cursor.
- Server-sent events: no schema.

## Consequences

The stream serves what the indexer has ingested; a lagging indexer means a lagging stream (the head message says where it is).
