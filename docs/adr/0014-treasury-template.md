# ADR-0014: Ownership-coin treasury template

Status: accepted (2026-10-05)

## Context

PRODUCT_FEATURES [X2, A5] asks for a treasury that holders can trust without trusting the team:
a spend allowance, release only on verified attestations, and holder-triggered pro-rata
liquidation when attestations lapse.

## Decision

A separate program, `treasury` (`programs/treasury`), one treasury per coin mint:

- **Fixed supply.** The coin's mint authority must already be revoked, so a liquidation snapshot
  cannot be diluted. A cross mints the coin and revokes its authority at finalize, so a launched
  coin satisfies this.
- **Custody.** Quote tokens sit in a vault owned by the treasury PDA. Funds arrive by plain
  transfer; for example, a cross's `proceeds_to` can be the vault.
- **Allowance.** The team (`authority`) may spend at most `allowance` per `period_secs`. Unspent
  allowance does not carry over. The allowance and period are fixed at creation.
- **Attestation gate.** Spending requires a live Solana Attestation Service attestation whose
  nonce is the treasury. That means the PDA `[attestation, credential, schema, treasury]`, owned
  by SAS, with matching fields and not expired. The attesting party, for example an auditor
  certifying a monthly report, controls renewal by closing and re-creating it. The parser is the
  shared `crates/sas-attestation`, which `cross_gate` also uses.
- **Lapse and liquidation.** Anyone may record a lapse while no live attestation exists, and
  anyone may clear it once one is back. If a lapse lasts `grace_secs`, anyone may trigger
  liquidation. That stops spending permanently and snapshots the vault balance and the coin
  supply.
- **Redemption.** Each holder burns coins for `snapshot_vault · amount / snapshot_supply` quote
  atoms, rounded down; rounding dust stays in the vault.

## Not in this version

- Votes for spends above the allowance, NAV-floor bids, and team-token milestone locks
  (PRODUCT_FEATURES E1–E3).
- Deposits made after the snapshot are not distributed by a second snapshot.

These build on this program without changing its accounts' meaning.

## Evidence

`tests/core/test/treasury.test.ts` runs against the SAS binary dumped from mainnet (4/4):

- A coin with a live mint authority is refused.
- Spending is refused with no attestation, beyond the allowance, by a stranger, or with the wrong
  attestation account; the allowance resets in the next period.
- After expiry and a recorded lapse, liquidation is refused until the 7-day grace ends, then
  anyone triggers it. A renewed attestation no longer revives the treasury, and holders get exactly
  6,000 and 4,000 of 10,000.000001, with 1 atom of dust left.
- A renewed attestation clears a recorded lapse before the grace period ends.

The devnet run waits on H10.
