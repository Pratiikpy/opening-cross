# ADR-0660: The upgrade timelock is checked from the chain, not enforced by a program (W2)

Status: accepted (2026-10-14)

## Context

PRODUCT_FEATURES [W2, V-E]: "`cross_settle` adapters (the Squads timelock >= max auction lifetime + 72h is planned and not enforced by the program)". The point is that no one, including the team, can upgrade the program that holds a live auction's escrow faster than the auction can end and its bidders can react. ADR-0013 rehearsed the handover to a Squads v4 multisig with a seven-day timelock on LiteSVM; the real handover needs three people with hardware wallets (H13).

## Options considered

- **Enforce it in `cross_settle` (or `cross_core`) by reading the program's own `ProgramData` and the Squads multisig.** A program can read the upgrade authority of a program account and the `time_lock` of a multisig account passed to it. But the check has to run somewhere: in `create_cross` it would refuse every cross on devnet, where the authority is one key and will be until H13; behind a flag it would be a rule the creator opts into, which says nothing about the program's own safety; and a cap on a cross's lifetime in `create_cross` would break the long-lived crosses (announced reopens, series) that exist today.
- **Check it from the chain, publicly, with a tool anyone runs.** `scripts/check-upgrade-timelock.mjs` reads every program in `Anchor.toml` on a cluster, finds its upgrade authority, and, given the multisig, checks that the authority is that multisig's vault and that its time lock is at least the longest a cross may stay open plus 72 hours. It exits non-zero otherwise.

## Decision

The second option. The honest statement of the guarantee is "the authority is a Squads vault whose time lock is at least X", and that is a fact about the cluster, verifiable by any reader without trusting us, not a property of the program's code. Enforcing it inside a program would not make it truer, and would make the devnet deployment unusable until H13.

Run against devnet on 2026-10-14 the script reports all five deployed programs with a plain-key authority (`DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC`) and exits 1: that is the state W2 describes. After H13 it is the proof that the timelock is in force, and it belongs in the release checklist next to `scripts/onchain-hash.sh`.

## Consequences

- W2 becomes a HUMAN row: the single step is H13 (the multisig and the handover). Everything else is built.
- `max-open-days` is a policy number: with the seven-day timelock of H13 it is four days, so a cross that must be open longer needs a longer timelock, not a different program.
