# ADR-0456: Recurring crosses: the series scheduler

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES Y1 (scheduler and the recurring flows) and the scheduler half of X1. Builds on ADR-0450 and the calendar (ADR-0011).

## Context

Y1 makes the recurring cross the core market: an ownership coin's secondary trading, treasury buybacks, holder exits and liquidations, and a stock's reopens are all crosses on a schedule that does not depend on a person. Until now a person created each cross.

## Decision

A **`Series`** (PDA of its authority and an id) holds the template of a cross and the source of its schedule: a fixed interval, or the session starts of a `cross_calendar`. Anyone may call `spawn_next` when the next cross is due. The program, not the caller, computes the close time (the first interval slot or session start after the previous close and now), the grid (fixed, or re-centred on the last print with ticks of a published share of it), the call window and the reference price; creates the cross with **the series' own address as its creator**; applies the series' rules in the same instruction; and pays the dust bond from the series' quote account. Crosses run one at a time: the next is spawned only once the previous has cleared or failed, and a missed slot is skipped. A cross is spawned at most 24 hours before it opens, so a series does not lock rent in crosses that are weeks away. The authority can pause the series, withdraw what it holds, and nothing else: the template is immutable.

**The flows** (buyback, exit, liquidation) are compositions of the same cross and need no further mechanism: an ownership coin's secondary trading is a series of escrow crosses; a treasury buyback is the treasury program's vault bidding into each cross (the treasury's NAV desk is ADR-0471); a holder exit is holders' sells; a liquidation is the treasury's inventory sold into the next cross. `rules-stocks.test.ts` runs a series on a calendar through a halt, a resume and a reopen; the treasury-side flows are fork T's ADR-0471.

## Not covered

Rent for a spawned cross's accounts is paid by whoever spawns it and is not reclaimed (there is no rent-reclaim instruction; a cross's accounts stay on chain). A series cannot carry rules that need the creator's signature (a bond) or the halt authority (a resume flag), because its creator is the series address (`create_series` refuses a bond). Keeper policy for who spawns (`services/keeper`) is outside this repo's program work.

## Evidence

`tests/core/test/rules-series.test.ts`: spawn, trade, settle, re-centre on the print and spawn again; one cross at a time and not before it is due; only the authority pauses it; it stops after its last cross; on a calendar each cross closes at the next session start.
