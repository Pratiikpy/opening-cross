# ADR-0702: Challenge reads, the arbiter's ruling, and the conditions of a series spawn

Status: accepted (2026-10-14). Builds on ADR-0454, ADR-0456, ADR-0505.

## Context

The routes that file, rule on and close insider challenges (`challenge-insider`, `resolve-challenge`, `expire-challenge`, `set-arbiter`) were built in W3A without the checks the program makes, and the challenge list was only an index read. A person read the program's error after signing: a challenge filed after the window, a ruling by anyone who is not the arbiter, a close one day after filing. `spawn-next` handed out a transaction for any series that was active, although the program also needs the previous cross resolved and the next close within a day.

## Decision

- **Reads from chain** (`routes/challenges.ts`): `GET /v1/arbiter` (the registry account: who rules, or that no one is named yet, H28) and `GET /v1/crosses/:address/challenge-state` (declared insiders, bond posted, held and slashed, the challenge window, and every open challenge with the second anyone may close it, and what holds `finalize` back). A challenge account is closed when it is ruled on or expires, so the chain read shows only open ones; the index route shows outcomes.
- **Checks before signing** (`rules-tx.ts`): `challenge-insider` refuses a cross not in `Cleared` or past `cleared_ts + challenge_secs` (409 `WINDOW_CLOSED`) and a subject that is already a declared insider; `resolve-challenge` reads the registry and refuses a signer that is not the arbiter (422 `NOT_THE_ARBITER`) or no named arbiter (409 `NO_ARBITER`); `expire-challenge` refuses before `filed_ts + 14 days` (409 `DEADLINE_NOT_REACHED`). The deadline is `ARBITER_DEADLINE_SECS` in the SDK.
- **Series** (`packages/sdk/src/series-schedule.ts`): `nextSeriesClose` and `spawnReadiness` are `next_close` and the top of `spawn_next`, ported case by case; the API refuses a spawn the program would (`SPAWN_TOO_EARLY` with the second it opens, `PREVIOUS_LIVE`, `PREVIOUS_MISSING`, `NO_SESSION_AHEAD`) and the keeper decides with the same function. A calendar series reads the calendar through `calendarFromAccount`, which checks the owner.
- **Lockups:** `lockupReleasable` is `Lockup::releasable`, in the SDK, for the keeper (the API route keeps its copy).

## Evidence

`services/api/test/challenges.test.ts` (4), `services/api/test/rules-tx-after.test.ts` (6, of which the challenge and series cases were extended), `packages/sdk/test/series-schedule.test.ts` (10, including a u64 amount over four years of vesting).

## Not covered

The arbiter's ruling itself (what is evidence of a funding link) is a judgement, not code, and no arbiter is named. `ArbiterRegistry` is read from its PDA on a local fixture only; the extended `cross_core` is not deployed, so the registry cannot exist on devnet. The upheld/rejected distribution of a slash (half to the challenger, half to the protocol) is the program's and was not recomputed here.
