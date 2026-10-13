# W2C-S4: auto-invest mandates (needs a program)

Outcome: **needs-program**. Nothing on the web or mobile side can honestly be built first: a mandate is only worth having if its limits and its kill switch are enforced by the chain, and no existing program enforces them. A screen that promised "max amount, expiry, kill switch" over an off-chain bot would be a claim nobody could verify, which the specification forbids ("onchain").

Why the existing programs cannot do it. `cross_core::commit_order` takes the order's `owner` as a signer and charges the escrow to the owner's token account. An agent that is not the owner can therefore only act with the owner's key, which is the thing a mandate exists to avoid. SPL token delegation does not help: the order account's owner is a signer of `commit_order`, and a delegate cannot sign as the owner.

## The change, for the programs agent

A new program `cross_mandate` (the repository already holds a program keypair for it under `.keys`, `cross_mandate-program.json`), no change to `cross_core`:

- `Mandate` PDA, seeds `["mandate", owner, agent]`: `owner`, `agent`, `quote_mint`, `allowed_base_mints: [Pubkey; 8]` (owner-chosen, ideally from the authenticity check), `max_per_order: u64`, `budget: u64` (what the owner deposited), `spent: u64`, `max_share_bps: u16` (at most 2,500, the specification's cap on any one cross), `expires_at: i64`, `revoked: bool`.
- A `MandateVault` token account owned by the Mandate PDA. The owner funds it with `deposit`; the budget is exactly what is in it, so the cap cannot be exceeded by construction.
- `create_mandate(owner)`, `deposit(owner)`, `revoke(owner)`: the kill switch. It sets `revoked`, and `withdraw` then returns the vault to the owner at any time, also after expiry.
- `place_order(agent)`: checks not revoked, not expired, base mint allowed, price times quantity at most `max_per_order`, the order's share of the cross's supply at most `max_share_bps`, then CPIs into `cross_core::commit_order` with the Mandate PDA as order `owner` (invoke_signed) and the vault as the escrow source. `spent` is increased by the escrow.
- `claim_to_owner(anyone)`: CPIs `claim` for the PDA-owned order and then `sweep`s the proceeds and refund to the owner's token accounts, so a mandate never holds results.
- Events for each step so the indexer can show a mandate's activity.

Tests that must exist: an order above `max_per_order` fails; an order after `revoked` fails; an order after `expires_at` fails; an order in a mint not on the list fails; the vault can never be overspent; the agent can never withdraw; the owner can always withdraw; a proof the share cap holds against a crowded cross.

Then the web and mobile side is small: a mandate page (create, fund, limits, expiry, a revoke button that is always visible, activity), and the agent side through the MCP server, which already refuses to sign.
