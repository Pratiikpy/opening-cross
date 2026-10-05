# ADR-0013: Upgrade and admin governance through a Squads v4 multisig with a timelock

Status: accepted (2026-10-05)

## Context

Two powers exist over the deployed protocol. The upgrade authority can replace program code.
The protocol admin can set the fee schedule for new crosses, rotate the guardian and pause new
activity (it can never reach escrow; see INVARIANTS I10, I11). Today one devnet key holds both.
Before mainnet (L4) no single key may hold either, and users must have time to leave before any
change lands.

## Decision

- Both powers move to the vault (index 0) of a **Squads v4** multisig: threshold **2 of 3**, a
  **7-day timelock**, no config authority (membership changes go through the same proposals).
  Squads v4 is immutable on mainnet (no upgrade authority), audited, and widely used for Solana
  program upgrades.
- The protocol admin moves with a new **two-step handover** in `cross_core`. `propose_admin` by
  the current admin is followed by `accept_admin`, signed by the proposed key, so a mistyped
  address cannot lock the protocol. `set_guardian` lets the admin rotate the guardian.
- The **guardian** stays a single fast key, because its only power is to pause new crosses and
  orders, which can never block claims or refunds. Pausing must be quick; anything that changes
  money or code waits for the timelock.
- The upgrade authority moves with the upgradeable loader's `SetAuthority` to the vault. Upgrades
  are proposed as vault transactions executing the loader's `Upgrade` from a buffer whose
  authority is the vault.

## Evidence

`tests/core/test/governance.test.ts` runs against the Squads v4 binary dumped from mainnet
(`tests/fixtures/fetch.sh`), with cross_core installed as an upgradeable program:

- After the handover, the old key can neither change fees nor upgrade.
- The vault's acceptance of the admin role fails before the timelock and succeeds after it.
- An upgrade with one approval fails. With two approvals it lands only after the timelock, the
  buffer is consumed, and the upgraded program runs.
- Edge cases: only the proposed key can accept, a proposal can be withdrawn, and guardian
  rotation is admin-only.

## Consequences

- Fee changes and upgrades are announced at least 7 days ahead, which is visible on chain as an
  open proposal.
- An urgent fix also waits 7 days. The guardian's pause covers the period, and funds can always
  be withdrawn through claims and refunds.
- Choosing the three member keys (hardware wallets held by different people) is a founder
  decision: HUMAN_TASKS H13.
