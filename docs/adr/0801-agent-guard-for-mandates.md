# ADR-0801: A mandate agent key signs three instructions, and a guard says so

Status: accepted (2026-10-15). Builds on ADR-0650.

## Decision

The API and the MCP server hold no keys, so the protection that an agent signs nothing else cannot be a signing policy in them. It is delivered where the key is: `inspectMandateAgentTransaction` in the SDK decompiles a transaction and accepts only `place_order`, `cancel_order`, `reveal_order` and compute-budget instructions; the same check is `POST /v1/mandates/check-transaction` and the MCP tool `oc_check_agent_transaction`, for a host that cannot link the SDK. A host runs it before signing and refuses on anything but ok.

The MCP server has drafts for place, cancel, reveal (the agent signs), and revoke and withdraw (the owner signs). It has none that creates, funds, re-limits or empties a mandate on an agent's behalf. Limits are checked twice: by the SDK and API before a transaction exists, and by the program on chain.

Not covered: the guard cannot see what a host does with the key outside a transaction it was shown.
