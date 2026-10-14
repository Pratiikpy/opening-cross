# ADR-0654: Adversarial bounty is a program, `cross_bounty` (X10)

Status: accepted (2026-10-14)

## Context

[X10] "Mainnet adversarial bounty auctions: we pay attackers to break live crosses." A bounty is only credible if the sponsor cannot take the money back when someone finds something, and only automatic if the chain can tell that something was found.

## Decision

A new program, `cross_bounty`. A bounty (`["bounty", sponsor, id]`) fixes, for good: the reward token, an arbiter, an expiry at least thirty days away, and a reward per invariant. Anyone can fund it. It pays in two ways and can be taken back in one:

- **Automatically**, to whoever shows a `cross_core` cross account that breaks one of eleven invariants (`violates` in the program): more orders open than placed; cleared without a summary; no-print without a reason; finalized with an order open; a clearing price off the grid; a fee above the caps; matched volume above the recorded demand or supply; sellers paid more than buyers paid plus the quote value of the undelivered base; a summary or reason on a cross still taking orders; buyers took more base than sellers delivered; buyers took more than was matched. A cross account is written only by `cross_core`, so such an account is proof of a bug, not a claim. Each invariant pays **once** (a bitmask), so a bug visible on fifty crosses costs one reward.
- **By the arbiter**, for what the chain cannot check (a theft path, a griefing vector, a rounding exploit with real funds). The award is capped by the pool, only before the expiry, and is an event carrying the hash of the report.
- **The sponsor** can withdraw only after the expiry.

## How the invariants were validated (the part that matters)

An invariant that fires on an honest cross would pay out the pool to anyone who looked. Each was run against randomized honest crosses at every stage (empty, with orders, cleared or not printed, partly claimed, fully claimed, finalized; open and sealed; escrow and mint modes; random fees and reference prices): 300 runs, 11 invariants, six stages, no false positive. The first draft of invariant 7 ("buyers paid in at least what sellers received") **was** a false positive in 8 of 300 runs: rationing leaves base delivered by sellers and not taken by buyers, which sellers are paid for. It was replaced by the exact bound that the rounding implies (`seller_paid <= buyer_paid + (sold - bought) * P / scale`, a theorem: buyers round up, sellers round down), and the old form is kept as a mutation that the honest runs must catch. Invariants that hold only empirically were not used; each kept one is either structural or a consequence of the rounding.

## What this does not claim

- Eleven invariants are not a proof of the program's correctness. They are the ones that are cheap to state, free of false positives and checkable from one account. A break in token flows (funds leaving a vault) is not visible in the cross account; that is the arbiter's part.
- The pool on devnet is test tokens. The mainnet bounty needs a funded pool (a human step, `docs/HUMAN_TASKS.md`).

## Consequences

- Program id `BSXaBkmhyypBNp5nfwb4GHAL7uDDLVR8Tr3UyHJKsWMz`, client `@opening-cross/cross-bounty-client`, 5 instructions, 5 events, 13 errors.
- The program reads the cross with `declare_program!`; a new field order in `Cross` would show in the bounty's tests.
