# ADR-0480: The settler PDA is the DBC partner, so `cross_settle` signs the partner's claims

Status: accepted (2026-10-13) · Rows D7, HD4 · Builds on ADR-0006 and ADR-0024

## Context

`open_dbc_pool` names the per-cross settler PDA as the `fee_claimer` (DBC's "partner") of the pool, so the mint authority and the partner powers sit with a key that only `cross_settle` can sign for. That was the right call for the mint (nobody can mint behind the cross's back) but it left the partner's money unreachable: the share of trading fees DBC assigns to the partner, the partner's surplus above the migration threshold, its slice of the migration fee and the pool-creation fee. `docs/HUMAN_TASKS.md` HD4 recorded the gap. The fee-sharing vault's DBC bridges (ADR-0024) cannot help here: they work when the fee vault itself is the DBC claimer, which would give the protocol no way to take its own revenue.

## Decision

Four permissionless instructions, each a CPI into DBC signed by the settler PDA:

- `claim_partner_fee` (DBC `claim_trading_fee2`): both token legs go to token accounts owned by `Cross.fee_recipient`, the recipient snapshotted when the cross was created. The base leg runs the `cross_gate` transfer hook, so the hook accounts travel as remaining accounts with the slice description DBC asks for.
- `withdraw_partner_migration_fee` (DBC `withdraw_migration_fee`, flag 0): to the fee recipient.
- `withdraw_partner_surplus` (DBC `partner_withdraw_surplus`): to an account owned by `Cross.proceeds_to` (ADR-0481).
- `claim_partner_pool_creation_fee` (DBC `claim_partner_pool_creation_fee`): lamports to the fee recipient's wallet.

Each one is permissionless because the destination is not an argument anyone can choose: the program reads the cross and refuses (`WrongDestination`) any destination whose owner is not the account the cross names. The config account is pinned to the cross's own DBC config PDA, so a pool of another cross cannot be claimed through this cross. The settler never holds tokens: DBC pays the destination directly, and the program reloads the destination to report the amounts it received in an event.

The pool's creator-side fees (`creator_trading_fee_percentage`) are not touched: the issuer's wallet is the pool creator and claims them directly with DBC's own instruction, so no program is needed.

## Consequences

- The protocol's share of trading fees is claimable for the first time, to the address the cross snapshotted. A fee recipient rotated after the cross was created does not redirect the fees of that cross.
- `cross_settle` grows by four instructions. The deployed program is 360,288 bytes, so a deploy needs `solana program extend` first.
- Proven against the real DBC binary in LiteSVM (`tests/core/test/settle-partner.test.ts`): the claim pays exactly the partner's accrued fee, a second claim pays nothing, a redirected destination is refused, and surplus and migration-fee withdrawals are refused by DBC before the curve completes. The post-migration payouts are proven in `settle-locked.test.ts`.
- NOT VERIFIED on devnet: no devnet SOL was available for the upgrade.
