# ADR-0703: The keeper's optional duties

Status: accepted (2026-10-14). Builds on ADR-0453 to ADR-0457, ADR-0011.

## Context

The keeper cleared, claimed and finalized. The Wave 2D programs left work that anyone may do and nobody was doing: batching refunds, closing insider challenges the arbiter left unanswered, paying vested lockups, spawning a recurring series, and keeping a halt state in step with the mint. The W3A report's remark that the keeper does not pass the rules tail to its builders was out of date: it has since commit 0f396ab (`readCrossExt` in every pass); the new tests exercise it.

## Decision

Five duties, each a pure planner over the accounts read in the pass (`src/duties.ts`, and `plan` for refunds) and one executor:

| Duty | Planner | Chain action |
|---|---|---|
| `refunds` | `plan` with `pushRefunds`, `refundOnly` | `push_refunds` for 2 to 12 orders |
| `challenges` | `planExpiries` | `expire_challenge` |
| `locks` | `planRelease` | `release_locked` |
| `series` | `planSpawn` (`spawnReadiness` of the SDK) | `spawn_next`, then `init_shard` and the other accounts the new cross lacks |
| `halts` | `planHalt` | `sync_pause`, `observe_price` |

- **Off unless named.** `KEEPER_DUTIES` defaults to `refunds,challenges,halts`: the duties that cost the keeper only transaction fees. `locks` pays for the owner's first token account and `series` for the rent of every cross it spawns, which the program does not return (W2D-Y1), so they are done only when named. A `KeeperDeps` with no `duties` does none: the keeper built before them behaves as it did.
- **Old layout stays safe.** `push_refunds` is used only on a cross with a rules tail (a cross that has one was created by a program that has the instruction); a cross without one is claimed order by order exactly as before. Series, halt states and lockups exist only in the extended program, so the discovery finds none on the deployed one.
- **`refundOnly` is exact, not a guess.** The program's `outcome` gives no fill for a cross that did not print, an order never revealed, a buy under the clearing price and a sell over it (`clearing_core::fill` returns 0 when an order does not cross; the allocation policy only touches the marginal buys at the price). Orders at the price, and those a draw left out, are claimed. If the program refuses a batch anyway, the keeper claims the same orders one by one in the same pass and does not batch that cross again for an hour (kept in `memory`; without it, for the rest of the pass).
- **`finalize` waits where the program does.** A cross with a bond (state `Cleared`) is not finalized while a challenge is open or before `cleared_ts + challenge_secs`; the pass says so, with a code, instead of failing every pass.
- **Halts run before the crosses.** A pause is put into the halt state before a cross that names it is cleared; the clear is given the halt state, which prints no price while the asset is halted or a corporate action is flagged. The keeper never lifts a halt: only a printing resume cross, created by the halt state's authority or venue signer, does, and the planner says so. The circuit breaker is fed only an update that is newer than the last observed one and younger than 90 seconds (the program accepts 120); there is no price poster here, so the update is the sponsored push-oracle account of a feed the operator named in `KEEPER_BREAKER_FEEDS`.
- **Dry run.** `dryRun` plans every action, lifecycle included, and sends none; the actions are in `PassResult.planned`.

## Evidence

`services/keeper/test/duties.test.ts` (22 `plan()` unit tests: every boundary of refunds, finalize, expiries, release, spawn, halts) and `test/duties-run.test.ts` (22 runs against an in-memory chain that applies the effect of each instruction sent: the work is done, a second pass finds nothing, a keeper restarted with no memory does not repeat it, a dry run sends nothing, an old-layout cross is driven as before, a competitor winning a race is not a failure). The in-memory chain (`test/helpers/world.ts`) is written from the program source, not the program.

## Not covered

No keeper pass was run against a validator or devnet: the extended programs are not deployed. `observe_price` needs a Pyth push-oracle account to be kept fresh by someone; nothing here posts updates. The keeper cannot create the resume cross (the authority does). `release_locked` is permissionless but its first call creates the owner's token account; whether a keeper operator wants to pay for that is the operator's call.
