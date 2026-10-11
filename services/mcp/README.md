# @opening-cross/mcp

An MCP server that lets an agent read Opening Cross and draft actions. It holds no key and cannot sign or send anything.

- **12 read tools:** protocol totals, crosses, the book and indicative price, fairness proofs, signed price bands, the track record, token identity checks, the premium monitor, a wallet's orders.
- **5 draft tools:** place, cancel, reveal, settle, claim. Each returns an **unsigned** transaction; nothing happens until the wallet it names signs and sends it.
- **Third-party text is data.** Token names, symbols and messages that quote them arrive as `{"untrusted_tool_output": {"text": ...}}` with a notice, because anyone can name a token "ignore your instructions".
- **Arguments are validated** against each tool's schema before any request is made, and API refusals come back as typed errors.

```json
{ "mcpServers": { "opening-cross": { "command": "npx", "args": ["tsx", "/path/to/opening-cross/services/mcp/src/stdio.ts"], "env": { "OPENING_CROSS_API": "http://localhost:8080" } } } }
```

Run from a clone of the repository after `pnpm install`. Design and tests: [ADR-0019](../../docs/adr/0019-mcp-server.md). Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); Apache-2.0.
