# services/docs-mcp

The documentation service: the repository's own documents served to people as a searchable site and to AI agents over MCP, with the diagnosis of a failed Solana transaction and its version-matched program documentation as a tool. Read-only, no key, no database, no outbound request.

```
DOCS_PORT=8793 DOCS_PUBLIC_URL=https://docs.example.org pnpm --filter @opening-cross/docs-mcp start
```

| Door | Address | For |
|---|---|---|
| Web pages | `/` (search and every document), `/doc?path=<file>[&section=<heading>]` | people; server-rendered, no script, light and dark, down to a phone |
| MCP, Streamable HTTP | `POST /mcp` (stateless) | agents; tools `oc_docs_search`, `oc_docs_read`, `oc_docs_list`, `oc_explain_error`, `oc_diagnose_failure`, all read-only |
| JSON | `/v1/docs/search`, `/read`, `/list`, `/explain` | anything that is not MCP |
| `/llms.txt`, `/healthz` | | agents' entry point; monitors |

The first three MCP tools are `services/mcp`'s docs server (`createDocsServer`), reused rather than copied. This service adds the two that use `@opening-cross/diagnose`: `oc_explain_error` (program and code, in decimal or the hex a log prints, to the error's name, its documentation's explanation, a link to its definition in the program's source at a pinned commit, and whether the documentation and source are for the same release as the IDL) and `oc_diagnose_failure` (an `err` and its logs to the plain-words diagnosis).

Environment, all optional: `DOCS_PORT` and `DOCS_HOST` (8793, 127.0.0.1); `DOCS_DIR` (the checkout); `DOCS_CORPUS` (a file from `pnpm --filter @opening-cross/mcp docs:corpus`, for a host without the checkout); `DOCS_KINDS` (what to publish; default everything except `runbook` and `security`, which describe how the operation is run, and a mistyped kind stops the start); `DOCS_PUBLIC_URL` (written into `/llms.txt`); `DOCS_RATE_PER_MINUTE` (120 per client, 0 off); `DOCS_TRUST_PROXY=1` (read the client from `X-Forwarded-For`, only behind a proxy that sets it).

Every answer carries the git revision the corpus was read at. Rendered pages escape every character of a document before adding markup, keep only `http(s)` links, anchors and links to other documents of the corpus, and are served with a policy that allows no script at all. An MCP request body is limited to 256 KB and an unknown path of the corpus is a 404, never a file read. The service is not published by the repository's Caddy configuration; put it behind the proxy or on its own address deliberately.

Tests: `pnpm --filter @opening-cross/docs-mcp test` (26, including the real server process over a socket with the MCP client) and `node e2e/site.e2e.mjs` (browser, 44 checks: WCAG 2.2 AA, no horizontal scroll, zero console errors, light and dark, desktop and phone). Evidence `docs/evidence/W5-1H.md`; decision `docs/adr/0972-hosted-docs-service.md`.
