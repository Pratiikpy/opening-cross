# Devnet proof — cross_calendar sessions, approved feeds and the 7-day timelock (C6)

Run: 2026-10-12T01:58:48.436Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/calendar-proof.ts` (`dp:calendar`). Real devnet transactions; expected refusals are simulated against the deployed program, so nothing failed is billed or recorded.
Programs: cross_calendar `CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN`, cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`. Admin, stranger and bidder are throwaway keys funded from the devnet promiser key.

**The 7-day timelock is a program constant** (`MIN_TIMELOCK_SECS`, `programs/cross_calendar/src/lib.rs`): a calendar with a shorter lock cannot be created, so no devnet calendar can be made to mature in minutes. The program was not changed to make that possible.

Not covered on devnet: a permissionless `apply_update` / `apply_admin` once the lock has passed (needs 7 real days). It is covered by `tests/core/test/calendar.test.ts`, which moves the LiteSVM clock to one second before and one second after the lock. A cross bound to an approved Pyth feed is shown to be accepted at creation (simulated); settling an oracle-guarded cross is covered by `oracle-pull.ts`.

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| refuse-short-lock | a timelock under seven days (604799 s) is refused | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:38. Error Code: TimelockTooShort. Error Number: 6000. Error Message: Timelock must be at least seven days. |
| refuse-overlap | overlapping sessions are refused | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:147. Error Code: BadSessions. Error Number: 6002. Error Message: Sessions must be increasing and must not overlap. |
| create | a calendar with a seven-day timelock, two sessions and one approved feed is created | PASS | [jRDqDsgQ…](https://explorer.solana.com/tx/jRDqDsgQshQDuYPaXKY9aMBUKnmZZDD4cdPN33x7ZaB4AnAcJjUACEiCPyWpEvYtW1ZbQLEHbiNiSQA385vkrNQ?cluster=devnet) | calendar H315quPNakZqwvGeFkWSEaNpHaygCVExs3dv8MAPULZB; sessions 1791770316, 1791856716 |
| refuse-off-session | a cross bound to the calendar cannot close at a time that is not a session start | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:330. Error Code: NotACalendarSession. Error Number: 6034. Error Message: The cross must close at the start of a calendar session. |
| refuse-unapproved-feed | a cross cannot pin an oracle feed the calendar has not approved | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:335. Error Code: FeedNotApproved. Error Number: 6035. Error Message: The oracle feed is not approved by the calendar. |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 155208080 lamports returned |

## Error

```
TypeError: Do not know how to serialize a BigInt
    at JSON.stringify (<anonymous>)
    at mustSucceed (C:\Users\prate\col\tests\devnet\src\kit.ts:199:78)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async main (C:\Users\prate\col\tests\devnet\src\calendar-proof.ts:82:95)
```
