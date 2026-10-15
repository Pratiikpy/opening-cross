# ADR-0970: The operations console is a web page that reaches its service through the web app, with the token in the tab

Status: accepted (2026-10-16) · Row R11 · Code `apps/web/src/app/ops`, `apps/web/src/components/ops`, `services/ops` · Evidence `W5-1H.md` · Extends ADR-0305

## Decision

1. **A page at `/ops`, not linked from the site, not indexed.** Four sections for the four things the service holds: listing reviews, incidents, compliance cases and the audit log. Each shows what the signed-in role may do and says why when it may not; a viewer is not offered forms, a reviewer is not offered the admin's resolve and close buttons.
2. **The browser never speaks to the service.** The service listens on a private address and is not published by the reverse proxy (ADR-0305, `docs/CONFIGURATION.md`). The web app's own route `/ops/api/v1/ops/...` passes a request on, server-side, to `OPS_CONSOLE_URL` (default `http://127.0.0.1:8792`). It forwards the `Authorization` header and the content type and nothing else (no cookie, no forwarded address), serves only `/v1/ops/...`, never the monitor's webhook (whose secret is in its path and belongs to the monitor), accepts only GET and POST, refuses a body over 64 KB, does not follow a redirect, and says so when the service is down or slow. Responses are never cached.
3. **The token lives in the tab's session storage.** Not in a cookie (so there is no ambient credential for another site to ride), not in local storage (so closing the tab ends the session). A token the service no longer accepts is dropped with a message.
4. **A second reviewer reads what the first one saw.** The service gains `GET /v1/ops/listings/:id` with the evidence gathered when the review was opened, and the queue names the sources that failed. Without it the second person decided blind, since the evidence was returned once, to the person who opened the review. Approving over a failed source needs a tick that names the source; the service still refuses without it.
5. **The log is read from its end.** `GET /v1/ops/log?order=desc[&before=<seq>]` returns newest first, so a long log is paged from the entries that matter. The page marks an entry whose `prevHash` is not the hash of the one before it; the verdict stays with the service's `verify`, which recomputes the chain and which the page shows with the entry it names. The signed head can be downloaded as a file.
6. **The forms check what the service would refuse for being malformed** (lengths, addresses, a reason of ten characters) and say so before sending. The service remains the authority; the page's checks mirror it and are tested against it.

## Alternatives rejected

- Letting the browser call the service with CORS: puts a privileged API on a public origin and needs an allow-list that drifts.
- A cookie session: an ambient credential, a cross-site request forgery surface, and a login system the service does not have.
- Rendering the console on the server with the token in an environment variable: one shared identity, which is the shared password ADR-0305 rejected.
- Showing the evidence only to the person who opened the review: makes the two-person rule a formality.

## Consequences

The console is only as private as the web app's route to the service: `OPS_CONSOLE_URL` must be a private address, and the proxy that fronts the web app should still restrict `/ops` to the operators' network if one exists (NOT VERIFIED here: no proxy configuration was changed or tested). A person's token is in the page's memory while it is open, so anything that can run script in the origin can read it; the site sets no third-party script, and `/ops` adds none. No login throttling exists (the service has none, ADR-0305). Real people and tokens remain HUMAN_TASKS H34.
