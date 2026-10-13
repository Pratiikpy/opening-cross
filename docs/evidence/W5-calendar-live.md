# Devnet proof: the calendar-driven keeper trigger, indexer and API (W5, T2, S9)

Run: 2026-10-13T10:02:26.446Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/calendar-live-proof.ts` (`dp:calendar-live`). Real devnet transactions. The API, indexer and keeper run as separate processes (`services/*/src/main.ts`, `services/keeper` with `KEEPER_CREATORS` set to the issuer) against a throwaway Postgres database.
Programs: cross_calendar `CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN`, cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`. Issuer, second creator, bidder and keeper are throwaway keys funded from the devnet promiser key and swept back afterwards.

The script sends no settle, claim or finalize for the issuer's cross: those come from the keeper process. The indexer starts from the newest cross_core signature at the start of the run (a checkpoint, not a backfill of devnet history); because orders by others on older crosses then arrive without their cross, the orders foreign key is dropped in this throwaway database; the cross_calendar history is read from the beginning, so earlier calendars from the C6 proof appear too.

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| api-before-index | GET /v1/calendar answers on an empty index with an empty list, not an error | PASS | — | status 200, 0 calendars, network devnet |
| calendar-create | a calendar with two sessions is created; the first starts in about five minutes | PASS | [49NAfz6E…](https://explorer.solana.com/tx/49NAfz6Exya3N7pc34jqn1v4J2yUbMsotGPqSHBZSMpKfsSzoFCCBLTiYDcd6FYpgLpGdJwE98brztmyPVhR2Cu6?cluster=devnet) | calendar ADYJFHjXVwSDWAbFxooekQ3NdXWc5nY3SCiBf8pxwmjR; first session 1791885694 (chain time 1791885334), second 1791972094 |
| cross-create | a cross scheduled on that session is created and records the calendar | PASS | [59dbAVhJ…](https://explorer.solana.com/tx/59dbAVhJ9wcR3G6uikn3c7XSN7NMb1uBHYX7mjTd8ppLLUB95ivLF4kMX5QKzx1v84DR9gPNWF6VTVKfh22uJQJn?cluster=devnet) | cross HiER3B8hny3VAy6nTFZGQ2WmvbgBAiJfUikFT2otbnGg, closes 1791885694 |
| bid | a bid is placed while the call is open | PASS | [3GKnkUWP…](https://explorer.solana.com/tx/3GKnkUWPXRDPULT5ywswdXShDW3tjcttX3NbFmMteH8UrsAN57bpNT4q9DbhwKbSfVohZu2pkHvZnThsmtJSczet?cluster=devnet) | order CHe7CFVexfMaz81UjCLaaL2K24fJKey2q9yLebacafim |
| foreign-cross | a second creator schedules a cross on the same session (outside the keeper's scope) | PASS | [ijYJwy9c…](https://explorer.solana.com/tx/ijYJwy9cCVacHbLEQTqTNwByS88eMHKbVTPM1bCmjPAZcsJHfgerbDA45S2vTM2ZfRmB5MAWuuNAojN51V4umv8?cluster=devnet) | cross 5F5wrxd2B1PSFBnggjudE55nmrFWXzDvV4J4eCx2JqXx |
| api-before | before the boundary the API shows the calendar closed, the first session as next, the index equal to the chain, and the cross bound to that session | PASS | — | state closed, next 1791885694, 2 cross(es), events CalendarUpdated, as of 1791885398 |
| api-list | GET /v1/calendar lists it too; the list is built from the index and re-read from chain | PASS | — | 12 calendar(s) listed; ours: {"state":"closed","next":"1791885694"} |
| indexed-event | the creation event is in the index under the creation transaction | PASS | — | CalendarUpdated 49NAfz6Exya3… |
| keeper-wake | before the boundary the keeper shortened its sleep to wake at the session start instead of waiting out a full pass | PASS | — | 1 wake line(s); the last one before the boundary: {"at":"2026-10-13T10:01:25.237Z","calendarWake":{"sleepMs":7500,"watching":1}} |
| keeper-cleared | the keeper cleared the cross within a minute of the session start with nobody pressing anything; its log names the calendar session | PASS | [4LiwKsAx…](https://explorer.solana.com/tx/4LiwKsAxtpPQQeYASmgerR5exCBDSeJN8iDBe8ZAeD9EwgP96WzZeeEi4EDDPnDGKcMNKKF3sbbDPkCHNHmKZoVT?cluster=devnet) | state 1, P* 1000000, matched 400000000; cleared 5s after the boundary (block time of the keeper's settle); log: {"cross":"HiER3B8hny3VAy6nTFZGQ2WmvbgBAiJfUikFT2otbnGg","calendar":"ADYJFHjXVwSDWAbFxooekQ3NdXWc5nY3SCiBf8pxwmjR","sessionStartTs":"1791885694","clearAfterTs":"1791885694","signature":"4LiwKsAxtpPQQeYASmgerR5exCBDSeJN8iDBe8ZAeD9EwgP96WzZeeEi4EDDPnDGKcMNKKF3sbbDPkCHNHmKZoVT"} |
| keeper-finalized | the keeper then paid the bidder its fill and finalized the cross | PASS | — | alice holds 400000000 base atoms; cross state Finalized |
| scope | the other creator's cross on the same session is still Live after the keeper finished its own: KEEPER_CREATORS is respected | PASS | — | state 0; keeper log mentions it: false |
| api-after | after the clearing the API shows the calendar open on the first session and the cross finalized with the chain's clearing price | PASS | — | state open, current 1791885694-1791886594, cross Finalized P* 1000000 matched 400000000, chain P* 1000000 matched 400000000 |
| reconcile | the calendar reconciler finds the index equal to every cross_calendar account on chain (zero drift) | PASS | — | 12 calendar(s) indexed, 12 on chain, 0 drift |
| indexer-log | the indexer logged no calendar drift and no error during the run | PASS | — | 4 log line(s) |
| keeper-log | the keeper reported no failed step | PASS | — | 3 log line(s) |
| cleanup | unused devnet SOL returned to the promiser key and the processes stopped | PASS | — | 279309320 lamports returned |
