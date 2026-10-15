# ADR-0925: Pool screens (D9, A10, X8, K5)

Status: accepted (2026-10-16).

## Decision

`/pools` (find by address or pair; the pools of the latest cleared crosses), `/pools/[address]` (price, fee, holdings, depth within price limits, cost of sizes, the bin chart of a DLMM pair, persistence, the accounts read, and a trade panel), `/pools/issuer/[cross]` (the issuer's view: movement from the clearing price, depth, what is left of the conviction ladder), `/pools/depth/[cross]` (the book's depth chart, price impact by size, the pools' slippage for the same sizes).

The trade panel prices the order against the pool, the next cross and Jupiter in one request, ranks every venue, says when another venue is better, and sends the swap to this pool through the existing wallet action: built by the API, simulated on the cluster, signed by the connected wallet. Nothing is computed on the page except the minimum shown, which is the API's rounding rule and is unit-tested against it. A missing value is "not read", never zero. Charts are SVG with a table behind each.

The dashboard page carries a table of the pools beside the generic liquidity card the API section produces.
