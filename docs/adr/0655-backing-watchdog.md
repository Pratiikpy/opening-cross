# ADR-0655: Auto-pause on missing backing is a program, `cross_backing` (F6)

Status: accepted (2026-10-14)

## Context

[F6] "Proof of backing for real assets; auto-pause if backing can't be verified." The attestation check exists off chain (`W2A-F-integrity.md`); the gap was a pause with no human in the loop. `cross_core` already has the right place for it: a `HaltState` per base mint with an optional **venue signer** that may halt the asset, and a halted asset resumes only through a printing resume cross (ADR-0455).

## Decision

A new program, `cross_backing`, whose PDA `["watchdog", mint]` is the venue signer.

- The issuer (the halt state's authority) opts an asset in once with `create_policy`: the attester it trusts, the coverage it commits to (1% to 200% of the live supply) and the longest age of a statement (one minute to thirty days). The halt state must name the watchdog as its venue signer, or the policy is refused: the opt-in and the halting right are both public and permanent.
- The attester posts `attest(backing_atoms)`; the time is the chain's.
- `check` (permissionless) halts the asset through `cross_core::set_halt` if the statement is missing, older than the policy allows, or the backing does not cover the **live** mint supply at the committed ratio. It refuses with `Backed` when the backing is fine, so a call that changes nothing says so.
- A fresh statement does not lift a halt. Only a printing resume cross does, so the first price after a halt is a one-price auction.

## What this does not claim

It does not prove that a custodian holds what the attester signed. The attester is whoever the issuer's holders are asked to trust (an operator decision, H32). The chain enforces that the claim exists, is fresh, covers the supply as it is now, and is made by the named key, and halts when any of those fail.

## Consequences

- Program id `HThrduwqRFvjHKPiQiRitsSw5yuGkXmAPkykAvMRQYkp`, client `@opening-cross/cross-backing-client`, 3 instructions, 3 events, 5 errors.
- An existing halt state created with another venue signer cannot use the watchdog (the venue signer is set at creation). New assets name it from the start.
- A keeper should call `check` for every opted-in asset on a schedule shorter than the shortest policy age.
