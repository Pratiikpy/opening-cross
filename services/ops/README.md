# services/ops

The operations console API: a listing queue, incidents, compliance cases and a hash-chained audit log.

```
DATABASE_URL=... OPS_TOKENS='[{"name":"alice","role":"admin","sha256":"..."}]' OPS_API_URL=https://... pnpm --filter @opening-cross/ops start
```

Every request needs `Authorization: Bearer <token>` (the server holds only each token's sha-256); with no tokens configured every request is refused. Roles: viewer reads; reviewer opens reviews, incidents, cases and notes and acknowledges incidents; admin resolves incidents, closes cases and verifies the log.

- **Listings:** the person who opens a review cannot decide it; a reason of at least ten characters is required; approving on evidence that could not be gathered needs `acknowledgeMissingEvidence: true`, which is recorded.
- **Incidents:** opened by hand or by the monitor's webhook (`/v1/ops/hooks/monitor/<OPS_WEBHOOK_SECRET>`) for a pause, a failed pause or a persisted critical finding; de-duplicated while open.
- **Cases:** notes are append-only; the audit log records that a note was added, not what it said.
- **Web console:** `/ops` in the web app (`apps/web/src/components/ops`, ADR-0970). The browser never talks to this service: the web app's own `/ops/api` route passes a request on server-side, with the person's token and nothing else, to `OPS_CONSOLE_URL` (default `http://127.0.0.1:8792`). It serves only `/v1/ops/...` routes, never the monitor webhook, and the token lives in the tab's session storage.
- **Reading a review:** `GET /v1/ops/listings/:id` returns one review with the evidence gathered when it was opened, so the second reviewer decides on what the first one saw; each row of the queue names the sources that failed. `GET /v1/ops/log?order=desc[&before=<seq>]` reads the end of the log, newest first.
- **Audit log:** each entry's hash covers the previous one and is written in the same transaction as the change; `GET /v1/ops/log/verify` finds the first edited or removed entry; `GET /v1/ops/log/head` returns the head signed by `OPS_KEYPAIR`.

Evidence: `docs/evidence/W2A-R11-ops-console.md`; decision: `docs/adr/0305-operations-console-api.md`; variables: `docs/CONFIGURATION.md`.
