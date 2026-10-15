# ADR-0972: The documentation is served as a hosted service for people and agents, built on the existing docs MCP

Status: accepted (2026-10-16) · Rows L7, J4 · Code `services/docs-mcp` · Evidence `W5-1H.md` · Builds on `services/mcp/src/docs-*`

## Decision

1. **A stdio and local-HTTP docs MCP already existed** (`services/mcp`, tools `oc_docs_search`, `oc_docs_read`, `oc_docs_list`, BM25 over the repository's markdown, tested). The status row saying there was no docs MCP was out of date. What was missing was a service someone can point at: a public address, a page a person can read, a plain JSON door, limits, and a policy on what is published.
2. **`services/docs-mcp` reuses that server rather than copying it.** It calls `createDocsServer` and registers two more tools on the same object: `oc_explain_error` and `oc_diagnose_failure`, which put `@opening-cross/diagnose` and its version-matched documentation (ADR-0973) in front of an agent.
3. **One handler, four doors.** Web pages for people (search, a rendered document, a rendered section), MCP over Streamable HTTP (stateless, so a restart or a second instance loses nothing), a JSON API (`/v1/docs/...`), and `/llms.txt`. All read the same in-memory index and say which git revision it was read at.
4. **What is published is a choice, and the default is cautious.** Runbooks and security notes describe how the operation is run; they are not served unless `DOCS_KINDS` says so, and they never enter the index, so no search or read can reach them. A mistyped kind stops the start.
5. **The pages are safe by construction.** Every character of a document is escaped before markup is added; raw HTML is shown as text; only `http(s)` links, anchors and links to other documents of the corpus are kept; the page policy allows no script. A section is shown under its document's title and its headings are shifted so no level is skipped.
6. **Limits.** A per-client fixed window (120 a minute by default, health not counted), a 256 KB cap on an MCP body, GET-only outside MCP, CORS open for reads.

## Alternatives rejected

- A second docs index inside the new service: two rankings and two corpora to keep in step.
- Rendering the documents with a markdown library and a sanitiser: more surface than a renderer that escapes first and understands only what the documents use.
- Serving Meteora's captured documentation text: its licence was not checked (NOT VERIFIED). Only links and the explanations the diagnosis attaches (a table cell per error) are used.

## Consequences

The new package's dependencies are linked locally in this checkout; `pnpm install` has to add it to the lockfile before CI can resolve it. The service is not in the Caddy configuration: someone decides its address. Rate limiting is per process and in memory, and behind a proxy it needs `DOCS_TRUST_PROXY=1` to see clients at all. Search is keyword ranking, not semantic search; it returns the author's own words with file and line, which is the point, and it will miss a question phrased in none of the document's words.
