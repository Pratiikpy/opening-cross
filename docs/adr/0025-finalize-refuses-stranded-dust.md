# ADR-0025: `finalize` refuses to strand base dust in an escrow-mode cross

Status: accepted (2026-10-13)

## Context

In an escrow-mode cross, rationing at the margin rounds the sell side up (ADR-0003), so after every
claim the base vault holds `base_sold - base_bought` atoms that belong to `proceeds_to`. `finalize`
sweeps them only when the optional accounts `base_vault`, `base_mint` and `proceeds_base` are
supplied. `finalize` is permissionless, and a call that omitted those accounts succeeded: the cross
became `Finalized` and the dust stayed in the vault, with no instruction left that could move it.
Writing the OCIP-1 specification found this by reading the code; `tests/core/test/finalize-dust.test.ts`
reproduced it on LiteSVM against vector E2 (13 base atoms sold, 12 bought, one atom stranded).

## Decision

`finalize` computes the dust it owes from state the program already keeps and refuses when it cannot
sweep it. If `supply_mode = Escrow` and `base_sold > base_bought`, then `base_vault`, `base_mint`
and `proceeds_base` must all be present, else the call fails with the new error
`BaseDustAccountsMissing` (code 6036) before any transfer.

- Every currently valid transaction stays valid unless it would have stranded dust: an escrow cross
  with no dust (nothing rationed) and a cross that did not print (nothing sold or bought) still
  finalize without the base accounts. Mint modes never need them for dust.
- The SDK builder (`buildFinalize`, `buildFinalizeWithAccounts`), the keeper, the API's
  `/v1/tx/finalize` and the client library already supply all three accounts for an escrow cross, so
  none of them changes.
- No account layout, instruction discriminator or argument encoding changes. The error is appended
  to the enum, so existing error codes keep their numbers. The `base_sold` and `base_bought`
  counters are existing `Cross` fields that `claim` has always maintained, so crosses created by the
  deployed build are covered.

## Alternatives considered

- Require the three accounts in every escrow-mode `finalize`. Rejected: it breaks valid calls on
  dust-free and no-print crosses for no safety gain.
- Make the accounts non-optional in the account struct. Rejected: it changes the instruction's
  account list and the mint modes do not have a base vault.
- Sweep the dust to a fixed program-derived account without extra accounts. Rejected: a token
  transfer needs the destination account in the transaction.

## Consequences

- A careless caller gets a typed error and a working retry instead of an irreversible loss.
- Base atoms donated directly to the vault (not sold by sellers) are not counted in the check; they
  are still swept whenever the accounts are supplied, and are not protected otherwise. They are not
  dust the cross owes.
- Requires a program upgrade of `cross_core` on every cluster that should have the guard.
