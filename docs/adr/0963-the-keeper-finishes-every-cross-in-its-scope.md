# ADR-0963: The keeper finishes every cross in its scope: the referrer's account and a series' crosses

Status: accepted (2026-10-16) · Rows V-E (keeper side), W4, Y8 · Builds on ADR-0456, ADR-0460, ADR-0703 · Code `services/keeper/src/referral.ts`, `services/keeper/src/scope.ts`, `services/keeper/src/discovery.ts` · Evidence `W5-1G.md`

Two defects were found by running the keeper against the real program and against the in-memory chain written from it. Each leaves a cross, and the money in it, waiting for a keeper that never comes. They share a rule: a keeper that accepts a cross must be able to finish it.

## 1. A referrer with no token account stops `finalize`

`finalize` refuses to run (`ReferralAccountMissing`, error 6065) when the cross names a referrer and the referral is non-zero but the referrer's quote token account does not exist or is not among the instruction's accounts. ADR-0460 notes that anyone may open the account first. `buildFinalizeWithAccounts` opens the fee recipient's, the integrator's and the proceeds recipient's accounts and not the referrer's, so the keeper's finalize of such a cross failed for ever when the referrer had never held the quote mint. On a validator running the real binary, the SDK's finalize without it is refused with exactly that error.

**Decision.** The keeper adds an idempotent create of the referrer's associated quote account to the finalize transaction. It costs the keeper one account's rent per referrer and mint, once. As first built it did so itself, when the cross's own arithmetic said `finalize` would pay a non-zero referral (the same floors as the program, so it opened nothing for a share that rounds to zero). In the integration of wave 5.1 the SDK's `buildFinalizeWithAccounts` took it over (see Alternatives), so every caller gets it and the keeper's own copy was removed; the one difference is that the builder, which does not read the fees, also opens the account for a share that rounds to nothing.

## 2. A scoped keeper lost the crosses its series spawned

`spawn_next` makes the series' own address the creator of what it spawns. The keeper's scope (`KEEPER_CREATORS`, required by the compose file) matched creators, so it found a subscriber's series, spawned the next cross and then never cleared, claimed, refunded or finalized it.

**Decision.** A cross is in scope when its creator is named or is a series whose authority is named. Discovery follows it (the indexer queries use `creator = ANY($1) OR creator IN (SELECT address FROM series WHERE authority = ANY($1))`; the program-account scan asks for the series of each named authority, then for the crosses of the authority and of each series), and the acceptance test the keeper passes to every duty reads the series once a pass (`keeperScope`). A failed read keeps the last answer and is logged.

## Alternatives rejected

- Telling operators to list every series address in `KEEPER_CREATORS`: the series are created by issuers after the keeper starts.
- Having `buildFinalizeWithAccounts` do it: it belongs there, and the integration of wave 5.1 moved it there. The SDK builder now opens the referrer's account whenever the rules name a referrer (also for a share that rounds to nothing, which is harmless: the create is idempotent), and the keeper sends the builder's transaction as it is. `ensureReferrerAccount` was removed from the keeper; `referralOwed` stays, as the arithmetic of what the referrer is paid.

## Evidence

`services/keeper/test/referral.test.ts` (8) and `scope.test.ts` (11, six against a real Postgres), each mutation-checked: removing the account creation fails two tests; the old acceptance test is shown to leave the spawned cross `Live` with its order open. On the real program: `services/keeper/scripts/referral-proof.ts`. `services/keeper/test/lifecycle-sends.test.ts` (6) states, by instruction discriminator, that the keeper sends `push_refunds`, `expire_challenge` and `release_locked` (the last only when `locks` is named), which `docs/FEATURE_STATUS.md` listed as not built.
