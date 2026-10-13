# ADR-0500: The SDK builders read the rules tail; they are not duplicated

Status: accepted (2026-10-14). Builds on ADR-0450 (the extension tail) and ADR-0452 to ADR-0460.

## Context

Wave 2D gave a cross an optional rules tail. A cross with rules needs different accounts from every instruction a client already builds: the shard of the ending bucket an order lands in, the applicant record, the class book, the lock vault and lockup of a locked claim, the merges of the ending buckets, the oracle accounts of the clear, the referrer at finalize. The proven construction lived only in `tests/core/src/rules-world.ts`, as test code.

Two designs were open: new builders for crosses with rules next to the old ones, or the old builders learning to read the tail.

## Decision

The existing builders (`buildPlaceOrder`, `buildReveal`, `buildCancel`, `buildSettleBook`, `buildClaim`, `buildFinalize`) take a `CrossView` whose optional `ext` is the rules tail, and add what the rules call for. With `ext` absent or null every one of them produces exactly the instruction it produced before. The instructions that exist only because of the rules (the draw, release of a lock, pushed refunds, challenges, halt states, the lender feed, series, the arbiter) are new builders in `packages/sdk/src/rules.ts`. A caller that reads a cross with `readRuledCross` (or the client's `readCrossFromChain`, which now returns `ext`) is rules-aware without knowing it; a caller that never learns about rules builds the same transactions as before, which fail on a cross that needs the extras.

Reasons: every caller (API, client, keeper, CLI, an integrator's script) has to pick the right builder, and a duplicated set means one of them picks wrong the day a cross has rules; the old call sites keep working on the old program; and one builder per instruction is one thing to test.

Three guards sit in the builders so that a mistake is a sentence and not a program error: a class or lockup on a cross without rules or on a sell is refused; reveal, cancel and claim on a cross with rules need the order's facts (`OrderFacts = { ext, isBuy }`, from `readOrderExt`); `buildSettleBook` throws `DrawRequired` while a draw is owed (`allowUndrawn` lets a test show that the program refuses it). `checkRules` mirrors every check `set_rules` makes and names the field; `wireSize` and `assertFits` measure a transaction as the network does, because LiteSVM does not enforce the 1,232 bytes (the defect that `rules-tx-size.test.ts` was written for).

## Consequences

- The transaction of an order in an ending period names the shard of a bucket the chain clock chooses. A transaction built for one bucket can land in the next and be refused. The builder takes `now`; the API answers `placement.validUntil`; the caller rebuilds. This is the cost of an open book with the buckets in separate shards and cannot be removed client-side.
- `settle` of a cross with extra oracle feeds defaults each extra account to the push-oracle account of the feed id (shard 0). A different account is passed explicitly (`oracleAccounts`).

## Evidence

`tests/core/test/sdk-rules-builders.test.ts` (55 tests): the construction of `rules-world.ts`, transcribed, against the SDK builders for twelve rule configurations, at six moments of the call, for buys, sells, classes, every order placement, claims, finalize, release, pushed refunds, `set_rules` with each extra account, the shards, the class book and the lock vault. `packages/sdk/test/rules-check.test.ts` (12). `docs/evidence/W3A-builders-devnet.md`: the builders against the deployed programs.

Not run: the program itself against these builders. LiteSVM needs Linux, and the 112 rules tests run the transcribed construction.
