# ADR-0005: `cross_core` program design

Date: 2026-10-05 · Status: accepted · Builds on ADR-0003 (clearing rule) and ADR-0004 (gating)

## Scope
`cross_core` owns everything that touches user funds in a cross: escrow, order entry, commit-reveal, aggregation, clearing, claims, refunds, fee accounting and the hand-off of proceeds. It never calls an AMM; settlement into pools is done by separate adapter programs (ADR to follow) from the proceeds `cross_core` releases.

## Accounts
- **Protocol** (singleton PDA `["protocol"]`): admin, guardian, fee recipient, fee schedule per cross kind, pause flags. A pause stops new crosses and new orders; it never stops reveals, clearing, claims or refunds.
- **Cross** (PDA `["cross", creator, cross_id]`): mints and token programs, supply mode, tick grid (`min_price`, `tick`, `ticks ≤ 256`), `price_scale`, timeline (`open_ts`, `close_ts`, `reveal_end_ts`), disclosure mode (sealed or open), optional reference price, print guards, fee snapshot, optional gate mint, counters, clearing summary, state.
- **Book shards** (zero-copy PDA `["shard", cross, i]`, `1 ≤ shards ≤ 32`): per-tick buy/sell quantities and order counts. An order writes to shard `sha256(owner ‖ nonce)` (first four bytes, little-endian) modulo `shards`, a function of what its owner already knows. The first design used `order_index % shards`, which depends on how many orders landed first: a devnet run with ten bids in flight at once found 39 of 40 failing with `WrongShard`, because every bidder had computed the shard from the same stale order count. Cancel and reveal recompute the shard from the stored owner and nonce, so no field was added to the order.
- **Book** (zero-copy PDA `["book", cross]`): the merged aggregate the clear reads.
- **Order** (PDA `["order", cross, owner, nonce]`): side, commitment or revealed `(price, quantity)`, escrowed amount, index, state.
- **Vaults**: quote vault, and base vault in escrow mode, owned by the cross PDA.

## Supply modes
- **Escrow** — sellers (holders, market makers, an issuer with existing tokens) escrow base when they commit. Used for reopens, tenders, unlocks and recurring crosses.
- **Mint** — the issuer's elastic supply schedule (immutable list of `(price, quantity)` sell levels) is fixed at creation, and the cross PDA holds the base mint authority. Buyers' fills are minted at claim; `finalize` sets the mint authority to None (proven on devnet, DP1/DP4). Used for launches, including the DBC continuation design, and avoids transfer hooks entirely because minting does not invoke them.

## Order flow
1. `commit_order` (call window) escrows funds and stores either a commitment `sha256(cross ‖ owner ‖ nonce ‖ side ‖ price ‖ quantity ‖ salt)` (sealed crosses) or the plaintext order (open crosses, revealed immediately). Buys escrow quote; the revealed `price × quantity` must fit the escrow. Sells escrow base ≥ quantity.
2. `cancel_order` (call window) returns the full escrow. No fee.
3. `reveal_order` (reveal window) checks the commitment and that the price is on the grid, then adds the order to its shard.
4. Unrevealed orders are excluded and refunded in full. (Encrypted default reveal, VM2, is a later upgrade.)

## Clearing and claims
- `merge_shard(i)` (permissionless, after the reveal window) adds a shard into the book once; a bitmap prevents double counting.
- `clear` (permissionless, all shards merged) runs `clearing-core` over the book plus the issuer schedule in mint mode, applies print guards, and records the summary — or marks the cross `NoPrint`.
- `claim` (permissionless; anyone may crank, proceeds always go to the order owner) computes the order's fill from the summary alone (ADR-0003), pays out, refunds the rest and closes the order.
  - Buyer: receives `fill` base and `escrow − ceil(fill·P*/scale)` quote.
  - Seller (escrow mode): receives `floor(fill·P*/scale) − fee` quote and `quantity − fill` base.
- `finalize` (all orders claimed): pays the issuer's proceeds in mint mode, splits fees, buys the rounding dust with the creator's dust bond, revokes the mint authority, and sweeps the provable remainder to the protocol fee recipient.

## Fees
Fees are charged on filled notional only, paid by the sell side (the issuer in a launch), so every buyer pays exactly `P*` — the product's promise. The cross snapshots `protocol_fee_bps` from the Protocol schedule for its kind and an `integrator_fee_bps ≤ 300` with recipient at creation; later schedule changes never touch an existing cross. Hard cap: protocol fee ≤ 100 bps. Bids, cancels and refunds are never charged. Final numbers are modelled before mainnet (Decisions log #2).

## Invariants (tested)
Vault ≥ liabilities at every step; Σ fills consistent with the summary; every order ends exactly once (claim closes it); a buyer never pays more than `P*` per unit; order independence; refunds reachable in every state including paused and `NoPrint`; mint authority None after `finalize` in mint mode; only the documented state transitions occur.

## Deliberately later
Random close (B14), encrypted default reveal (VM2), Arcium sealed bids (DP9), identity-verified lottery tier, geometric tick grids, transfer-hook base mints in escrow mode (needs extra-account forwarding), adapter CPI.
