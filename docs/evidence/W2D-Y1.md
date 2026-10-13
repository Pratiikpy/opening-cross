# W2D-Y1: recurrence scheduler and flows (Y1)

Outcome: **BUILT-LOCAL**, partial. Design: ADR-0456.

Built: `Series` with `create_series`, `spawn_next` (permissionless; the program computes the close from an interval or the calendar's sessions, re-centres the grid on the last print, creates the cross with the series as creator, applies the series' rules and pays the dust bond), `set_series_active`, `series_withdraw`. Tests (`rules-series.test.ts`, 5): spawn, trade, settle, re-centre, spawn again; one cross at a time and not before due; only the authority pauses; stops after its last cross; closes at the next calendar session. `rules-stocks.test.ts` runs a series on a calendar through a halt and a resume.

The recurring flows (buyback, exit, liquidation) are the same cross: a holder exit is holders' sells; a buyback is the treasury program's NAV desk bidding (fork T's ADR-0471); a liquidation is the treasury's inventory sold in. No further mechanism.

Not built: reclaiming the rent of spawned crosses (the spawner pays and does not get it back); a series cannot carry a bonded or resume-flagged rule.

FEATURE_STATUS.md row wanted: `| Y1 recurring cross | BUILT-LOCAL, partial | Series scheduler on an interval or a calendar (the program computes the close and re-centres the grid), pause and withdraw; 5 LiteSVM tests and a calendar composition (`W2D-Y1.md`, ADR-0456) | Buyback, exit and liquidation are compositions (the treasury NAV desk is ADR-0471), not separate flows; spawned crosses' rent is not reclaimed; devnet proof pending funding; not audited |`
