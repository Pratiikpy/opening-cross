# Devnet proof — cross_calendar sessions, approved feeds and the 7-day timelock (C6)

Run: 2026-10-12T02:12:44.860Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/calendar-proof.ts` (`dp:calendar`). Real devnet transactions; expected refusals are simulated against the deployed program, so nothing failed is billed or recorded.
Programs: cross_calendar `CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN`, cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`. Admin, stranger and bidder are throwaway keys funded from the devnet promiser key.

**The 7-day timelock is a program constant** (`MIN_TIMELOCK_SECS`, `programs/cross_calendar/src/lib.rs`): a calendar with a shorter lock cannot be created, so no devnet calendar can be made to mature in minutes. The program was not changed to make that possible.

Not covered on devnet: a permissionless `apply_update` / `apply_admin` once the lock has passed (needs 7 real days). It is covered by `tests/core/test/calendar.test.ts`, which moves the LiteSVM clock to one second before and one second after the lock. A cross bound to an approved Pyth feed is shown to be accepted at creation (simulated); settling an oracle-guarded cross is covered by `oracle-pull.ts`.

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| refuse-short-lock | a timelock under seven days (604799 s) is refused | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:38. Error Code: TimelockTooShort. Error Number: 6000. Error Message: Timelock must be at least seven days. |
| refuse-overlap | overlapping sessions are refused | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:147. Error Code: BadSessions. Error Number: 6002. Error Message: Sessions must be increasing and must not overlap. |
| create | a calendar with a seven-day timelock, two sessions and one approved feed is created | PASS | [21qHFnYp…](https://explorer.solana.com/tx/21qHFnYpbo4cxKkc64syhARqvwzXKQgh1NMpdJLks9KiwDbHHk5kmVoLhf3dSghddmDhEmTbMjU4dbk2PPjdDDeT?cluster=devnet) | calendar 2vZwWzDZe6v4AJKYtoLyXP9sZuA9D9Uu68SMtzHvR3zq; sessions 1791771150, 1791857550 |
| refuse-off-session | a cross bound to the calendar cannot close at a time that is not a session start | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:330. Error Code: NotACalendarSession. Error Number: 6034. Error Message: The cross must close at the start of a calendar session. |
| refuse-unapproved-feed | a cross cannot pin an oracle feed the calendar has not approved | PASS | — | Program log: AnchorError thrown in programs/cross_core/src/lib.rs:335. Error Code: FeedNotApproved. Error Number: 6035. Error Message: The oracle feed is not approved by the calendar. |
| accept-approved-feed | the same cross with the approved feed is accepted | PASS | — | simulation succeeded (50741 compute units) |
| calendar-cross | a cross closing at the session start is created and records the calendar | PASS | [ac2J8QC5…](https://explorer.solana.com/tx/ac2J8QC5ZAkME44FRV8ZSypBnXMXL3odKwgTJBCAiy9KgbcgHtmMkCQEtMKfwPpAFusPJijEv2RVDxUJM9T1AHC?cluster=devnet) | cross FQD8KLfm3GX3ZspY4sTLzjaBmMSUpuqKNgcCcoMSbSkW, closes 1791771150 |
| calendar-bid | a bid is accepted while the call is open | PASS | [2eBmP3Na…](https://explorer.solana.com/tx/2eBmP3NaaxvRcSGLqn1oL66HMYM3VBiA2sWbLSkt9Tj6Eyvhcie21A1TCxyY5bXQ84RjQBXDPtwwHwB61G4gVGRJ?cluster=devnet) | order account exists |
| refuse-stranger-propose | a non-admin cannot propose a change | PASS | — | Program log: AnchorError caused by account: calendar. Error Code: Unauthorized. Error Number: 6005. Error Message: Signer is not the calendar admin. |
| propose | the admin proposes a new session list; its apply time is the proposal time plus seven days | PASS | [32ZrBpXt…](https://explorer.solana.com/tx/32ZrBpXt9UeDBZwg79a6ByLbwFSZ4qs6M6xQgeMxprHSCnQADpfcjKWrSgn19YSUhguea4s5HwthzqvAXzvNyGio?cluster=devnet) | eta 1792375752 (chain time 1791770952, +604800 s) |
| live-unchanged | the live calendar is unchanged while the proposal waits | PASS | — | 2 sessions |
| refuse-apply-now | anyone applying immediately is refused (TimelockActive) | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:97. Error Code: TimelockActive. Error Number: 6004. Error Message: Timelock has not passed. |
| cancel | the admin cancels the proposal during the wait | PASS | [2WxvRcuJ…](https://explorer.solana.com/tx/2WxvRcuJEbdAekBGhPTVJbcjjGjaaiCuT5pwmudWn5udqTcGJueFZuuUETm4NEfwx15z1fACNx3H1bwjXzciG6nZ?cluster=devnet) | pending cleared |
| refuse-apply-cancelled | applying a cancelled proposal is refused (NothingPending) | PASS | — | Program log: AnchorError occurred. Error Code: NothingPending. Error Number: 6003. Error Message: No pending update. |
| propose-admin | an admin handover is queued behind the same lock | PASS | [46mHwxyU…](https://explorer.solana.com/tx/46mHwxyUnthJut4RWM3ND9F9c7wfZDqtPvfdHApcqADAZxzqJFFRJ9WmCtKGgjsbJbfGVzuzi85c9zakT3d1pqc9?cluster=devnet) | eta 1792375758 |
| refuse-apply-admin | the handover cannot be applied early (TimelockActive) | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:129. Error Code: TimelockActive. Error Number: 6004. Error Message: Timelock has not passed. |
| calendar-clear | the cross clears at the session start | PASS | [hAJ2Sk9D…](https://explorer.solana.com/tx/hAJ2Sk9DGW6iKyJBXjtvoxr6mxNqXvcHvuCpZQ5xk2NjcmiwvRxCgU1Ghu6GbefmPm3SEW4rdyYVcENGRLfHpYk?cluster=devnet) | P* 1000000, matched 400000000 |
| calendar-claim | the bidder receives its fill | PASS | [2Jx2kxzn…](https://explorer.solana.com/tx/2Jx2kxznembP41LHhpcJqKxxjZpPdXCggLKYpkroMKZmiaH6QWR48EjyXYqb9SeVK9bD66ewEhkhy3xnmw7CWP7U?cluster=devnet) | alice holds 400000000 base atoms |
| calendar-finalize | the cross finalises | PASS | [YdbM63E9…](https://explorer.solana.com/tx/YdbM63E98uwH4k3wmoRdkTVSs8G1LFcKYi7H6SmB4VMeATdcGuYQgLXgBS7RpX7HNo1GNyAqiPavJGqjhTnPuUP?cluster=devnet) | state Finalized |
| lock-still-running | after the cross has settled the restarted lock still has almost the full seven days left, and a stranger still cannot apply | PASS | — | 604594 s remaining of 604800 |
| refuse-apply-late | applying is still refused (TimelockActive) | PASS | — | Program log: AnchorError thrown in programs/cross_calendar/src/lib.rs:97. Error Code: TimelockActive. Error Number: 6004. Error Message: Timelock has not passed. |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 80898640 lamports returned |
