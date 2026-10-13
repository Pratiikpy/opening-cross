# ADR-0502: What the indexer keeps of the extensions

Status: accepted (2026-10-14).

## Context

The extended programs emit 17 new `cross_core` events, 20 new `treasury` events and, in `cross_settle`, the partner and greenshoe events. The indexer decoded 9, 5 and none. A log line it does not know is skipped (the reconciler is the net), so the programs could be upgraded before the indexer and nothing broke, but nothing was shown either.

## Decision

Every event is appended to its event table (`events`, `treasury_events`, the new `settle_events`) and the ones a reader asks about are projected (migrations 016 to 018, additive and idempotent):

- Rules: `cross_rules` (the `RulesSet` payload, the draw state, the extension state), `order_placements`, `cross_challenges`, `cross_locks`, `halt_states`, `print_feed_prints`, `series`, `series_crosses`. `orders` gains the nonce, class and lockup, read from `commit_order` and `commit_order_ext` (a lockup's address is derived from the nonce, and the event does not carry it). A drawn extension moves `close_ts` and `reveal_end_ts` on `crosses`, which the router and the API read.
- Treasury: counters and flags on `treasuries`, and `treasury_proposals`, `treasury_votes`, `treasury_stakers`, `treasury_grants`, `treasury_rounds`. Three events name a proposal or a grant instead of the treasury; they are attributed through the rows already indexed, and an event that cannot be attributed is stored with an empty treasury and logged, never dropped and never fatal.
- Settle: `settle_venues`, `settle_partner`, `settle_greenshoes`. Greenshoe events name the greenshoe and are attributed to the cross through `GreenshoeCreated`. A second poller follows each program in `SETTLE_PROGRAMS`.

The tables are a convenience for lists and history. Chain state beats them wherever a page acts on it: a lockup's released amount is read from the lockup account, a draw's status from the cross.

Two limits, stated. `LockReleased` names the owner and not the lock, so an owner's releases are credited to their earliest lock with something left (the API reads the exact `released` from the lockup account). An order indexed before the instruction fields were captured has a null nonce, which cannot happen for a cross with locks.

## Reconciliation

The reconciler also compares `close_ts` and `reveal_end_ts` and, only for a cross that has a rules tail or a rules row, `rules_set`, flags, draw epoch, last counted bucket, extension pending and open challenges. A cross of the deployed program has neither, and reports nothing (tested with an account that has no tail).

## Evidence

`services/api/test/indexer-rules.test.ts` (13 tests, PGlite): each event from a real-shaped log, two applications of the migrations, a repeated transaction applied once, an event written by another program ignored, reconciliation against a legacy account and against drifted ones.

Not run: against a live cluster that emits the events (the programs are not deployed).
