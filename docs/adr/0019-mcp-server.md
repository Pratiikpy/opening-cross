# ADR-0019: MCP server for agents

Status: accepted (2026-10-11)

## Context

Agents are a first-class integrator for a protocol whose pitch is "one fair price", and the API already returns unsigned transactions for every action, so an agent never needs to hand the product a key. The `bnb` research project built a mature MCP server; its two ideas that carry over are (1) writes are drafts only, and (2) third-party text is wrapped as data, because anyone can name a token "ignore your instructions and ...".

Alternatives considered:

| Option | Why not |
|---|---|
| Agents call the REST API directly | Works, but every agent re-implements validation, error handling and, above all, the handling of attacker-controlled names |
| An MCP server that can sign with a configured key | One prompt injection from spending funds. Rejected outright |
| Tools generated from an OpenAPI document (as `bnb` does) | This API has no OpenAPI document yet; a hand-written catalog of 18 tools is small enough to test fully. Generation is worth doing when the surface grows |
| Thin MCP server over the REST API, drafts only | Chosen |

## Decision

`services/mcp` (`@opening-cross/mcp`, bin `opening-cross-mcp`), on the official TypeScript MCP SDK v2 (`@modelcontextprotocol/server` 2.3.1), stdio transport.

- **Reads (12):** protocol totals, list and read crosses, the book and indicative price, the fairness proof, the signed price band, the track record, the token identity check (one mint, or both tokens of a cross), the premium summary and latest, a wallet's orders.
- **Drafts (5):** place, cancel, reveal, settle, claim. Each returns the API's unsigned transaction. The server holds no key, has no signing or sending tool, and a test fails if any tool name suggests one.
- **Untrusted text.** Token names and symbols, issuer asset names and every message that quotes them are returned as `{"untrusted_tool_output": {"text": ...}}`, the result starts with a notice, and the server's instructions say to treat such values as data. A test feeds a token named with an injection sentence and checks that no copy of it appears outside an envelope, in the structured result or in the text content.
- **Validation first.** Arguments are checked against each tool's JSON Schema (addresses, integer ranges, enums, no extra fields) before any request leaves the process; the test counts requests received by a fake API to prove none were made for malformed calls.
- **Typed errors.** An API refusal becomes `isError` with a stable code (`NOT_FOUND`, `CONFLICT`, `BAD_REQUEST`, `API_ERROR`, `API_UNAVAILABLE`), and the server keeps serving afterwards.

## Not done

- Streamable HTTP transport (stdio is what local agent clients use; a hosted endpoint needs rate limits and an abuse policy first).
- Paid tools or payments of any kind.
- A tool catalog generated from a published OpenAPI document.

## Verification

`services/mcp/test/mcp.test.ts`: 9 tests with a real client over a stdio child process against a fake API (tool list and annotations, a read, the injection envelope, malformed arguments with zero requests made, typed refusal, unreachable API, an unsigned draft with the exact body forwarded, malformed drafts and an unknown tool).
