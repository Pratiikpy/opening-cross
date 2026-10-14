# W3D-S4: auto-invest mandates (`cross_mandate`), proved on LiteSVM

Status 2026-10-14: **program, client and tests built; proved on LiteSVM against the real `cross_core` binary; not deployed (devnet needs funding, H27).** Not audited. ADR-0650. Rows S4, J2.

## What was built

A new program `83EvNHUpKzguAUmyBHJgktVsVLzp3sCXYysgzmToLhs1` (368,576 bytes), 10 instructions, 8 events, 17 errors, and the client `@opening-cross/cross-mandate-client`. No change to any deployed program.

A mandate names an owner and one agent. The budget is the vault (the quote associated token account of a data-less signer PDA); the signer PDA owns every order the mandate places, so refunds and no-prints pay back into the vault and the agent has no instruction that moves a token anywhere but into a cross. `place_order` (agent only) checks: not revoked, not expired, escrow at most `max_per_order`, lifetime committed at most `total_cap`, vault funds, cross quoted in the mandate's token and on the allow list (base mint, creator or one cross), at most `max_share_bps` (capped at 2,500) of the cross's declared supply, the signer PDA can pay the order's rent. Then it calls `commit_order` as a buy. `revoke` is immediate and permanent. `withdraw`, `withdraw_lamports` (owner) work at any time. `cancel_order` and `reveal_order` (owner or agent) finish what was authorised. `sweep` (anyone) moves the base to the owner.

## Tests

- `tests/core/test/mandate.test.ts`: **20 passed**. End to end against the real `cross_core`: the agent buys, the cross clears, the base reaches the owner, the fill and the refund equal an ordinary buyer's, every atom is accounted for; a sealed order is committed by the agent and revealed by the owner (a stranger cannot reveal); a no-print refunds into the vault. Each limit at its edge: per-order (limit passes, one atom over fails), lifetime cap (raised only by the owner), share (exactly 25% passes, one atom more fails; a sealed order is measured by its escrow at the lowest price), a cross with no declared supply, expiry, the three allow rules, a cross in another quote token, an underfunded vault, missing rent. Who can do what: only the agent places; the agent cannot withdraw, change limits, revoke, fund, redirect a sweep or send the quote through `sweep`; the escrow cannot be pointed at the agent's account and a lookalike cross is refused; seven bad shapes of limits and an agent equal to the owner are refused at creation. Kill switch: after `revoke` no order, the open order can still be cancelled and the funds withdrawn; the agent can cancel and the refund lands in the vault; the owner takes back the rent float but never leaves a non-rent-exempt remainder; two mandates of one owner are independent.
- `cargo test -p cross_mandate`: **6 passed** (share boundary exact, no overflow into a pass, the escrow bound is an upper bound on any fill, limits, and `tail_offsets_match_cross_core`, which builds a real `CrossExt` and asserts the byte offsets, cross body size and order size this program reads against the `cross_core` crate).
- Mutation checks (each applied to the program, rebuilt, the suite run, the change reverted): share check removed -> 2 tests fail; revoked check removed -> 1 fails; the owner binding of `sweep`'s destination removed -> 1 fails.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings`: clean.

## Compute units (LiteSVM)

place_order 48,102 · create_mandate 46,801 · cancel_order 40,853 · sweep 27,333 · fund 19,281 · withdraw 15,947 · reveal_order 15,385 · withdraw_lamports 5,614 · set_limits 3,834 · revoke 3,129. Each fits one transaction with a wide margin.

## Size and deploy cost

368,576 bytes. Program account rent 1.873 SOL (permanent) and a 1.873 SOL buffer returned after the deploy; `scripts/deploy-batch-3.sh` prints the batch total (8.699 SOL permanent for the six new programs, 10.088 SOL balance needed to start).

## Not covered

Devnet (not deployed); a gated cross (the signer PDA would need a `cross_gate` pass; remaining accounts are forwarded but no pass is created) and an identity-limited cross; a Token-2022 quote mint with a transfer hook; sell orders (not offered, by design); "integrity-gated inputs" (an authenticity check before an order) is the agent's and the API's job, the allow list is the on-chain substitute; an audit.

## FEATURE_STATUS row wanted

`| S4, J2 auto-invest mandates | PARTIAL | A `cross_mandate` program: an agent places buy orders from a vault the owner funds, inside on-chain limits (per order, lifetime cap, at most 25% of a cross's declared supply, expiry, allow list); an immediate, permanent revoke and withdrawal at any time; 20 LiteSVM tests against the real `cross_core` and 6 unit tests (`W3D-S4.md`, ADR-0650) | Not deployed (H27); no SDK builders, API route, indexer projection, MCP tool or mandate page; a gated or identity-limited cross needs the signer PDA to hold a pass; not audited |`

## What the app layers must add

SDK: builders for the ten instructions and the PDA helpers (`findMandatePda`, `findSignerPda` are generated), including the order-PDA and shard derivation for the signer PDA and the remaining accounts a ruled cross needs (the test helpers `tests/core/src/mandate-world.ts` are the reference). Indexer: project the 8 events (`MandateCreated`, `MandateFunded`, `LimitsChanged`, `MandateRevoked`, `MandateWithdrawn`, `MandateLamportsWithdrawn`, `MandateSwept`, `MandateOrderPlaced`) and the `Mandate` account. API: read routes for a mandate and its orders, unsigned-transaction routes for create, fund, set limits, revoke, withdraw. MCP: an agent tool that places orders (it must refuse to sign anything but `place_order`, `cancel_order`, `reveal_order`). Web and mobile: the mandate page (create, fund, limits, expiry, an always-visible revoke, activity). Diagnose: add the 17 errors to the error tables.
