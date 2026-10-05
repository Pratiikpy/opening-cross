# Invariants

Properties that must hold for every cross, at every step. Each names where it is enforced and
which test checks it. An auditor should try to break each one.

| # | Invariant | Enforced in | Checked by |
|---|---|---|---|
| I1 | Every filled order trades at the single clearing price P*. | `claim` computes payment from `clearing.price` only | `properties.test.ts`, conformance (fills) |
| I2 | No buyer pays above their limit; no seller receives below theirs. | `clearing_core::fill` returns 0 for orders that do not cross P* | proptest `fills_conserve_and_respect_limits` |
| I3 | Orders strictly better than P* fill in full; only orders exactly at P* on the long side are rationed, pro rata (buys floor, sells ceil). | `clearing_core::fill` | conformance curated cases; proptest |
| I4 | P* is the ADR-0003 choice: max volume → min imbalance → nearest reference → lowest price. | `clearing_core::clear` | proptest `matches_exhaustive_reference`; 525 vectors (TS reference and program) |
| I5 | Sum of buyer payments ≥ sum of seller receipts plus fees, and the difference is bounded by the dust bond. | `buyer_pays` ceil, `seller_receives` floor, `dust_bond` at create | proptest `vault_never_short`; properties "empties the vaults" |
| I6 | After finalize, both vaults are empty: every atom went to an owner, the issuer, the integrator or the fee recipient. | `finalize` requires `orders_open == 0` and sweeps the remainder | `properties.test.ts`; `flows.test.ts` |
| I7 | Each order is paid exactly once. | `claim` closes the order account | adversarial T8 test |
| I8 | A cross that does not print refunds every order in full. | `claim` in `NoPrint` returns the whole escrow | adversarial; deferred "abandoned settlement…" |
| I9 | A minting cross creates base supply only at settlement, equal to the filled quantity. At finalize the authority is revoked if the cross printed, or returned to the creator if it did not. | `claim` mints fills; `finalize` sets the authority to none (printed) or the creator (no print) | dbc test; api "one-signature mint handover" |
| I10 | Parameters fixed at creation never change (grid, window, fees, guards, gate, oracle). | No instruction writes them after `create_cross` | fees "never touches live crosses" |
| I11 | Pause never blocks reveal, clear, claim, refund or finalize. | `paused` checked only in `create_cross` and `commit_order` | adversarial T14 test |
| I12 | Protocol fee share ≤ 20% of total fees, and none is charged on cancels or refunds. | `protocol_fee_bps = min(schedule, integrator/4)` | `fees.test.ts` |
| I13 | Order and book counters agree: `orders_open` equals the open order accounts. | `commit_order` / `cancel_order` / `claim` | indexer reconciler (`orders_open`); keeper test |
