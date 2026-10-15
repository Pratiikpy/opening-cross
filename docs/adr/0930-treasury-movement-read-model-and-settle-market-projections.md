# ADR-0930: A treasury movement read model, and projections for the DAO and tranche a cross opens without a pool

Status: accepted (2026-10-16).

## Context

Three gaps stood in the status table. The indexer did not decode `FutarchyDaoSeeded` (row X3) or `FixedPricePresaleOpened` (row B4), so the settlement read could not list a MetaDAO DAO or a fixed-price tranche, and no MCP tool drafted either instruction. Row F5 (alerts on insider, team and treasury movements) had no read model: the treasury indexer keeps every event in `treasury_events` and sums a few of them onto `treasuries`, but nothing answers "what left this treasury, to whom, and was it one of the team's outflows" without parsing each payload and chasing proposals and grants by hand.

## Decision

**DAO and tranche projections (migration 020).** `settle_futarchy_daos` is keyed by the DAO and `settle_presales` by the presale, each indexed by cross. They are not columns of `settle_venues`, which holds one pool venue per cross: `seed_futarchy_dao` takes a creator and a nonce, `open_fixed_price_presale` takes a fresh `base` keypair, and the program keeps no per-cross marker, so one cross can legitimately open several of either, next to a pool. `settlementMarkets(db, cross)` returns both lists, oldest first, for `GET /v1/crosses/:address/settlement`. The presale's `q_price` is a `u128`, stored as `NUMERIC` and read back as text.

**Movement read model (migration 020, `src/treasury-movements.ts`).** `treasury_movements` holds one row per treasury event that moves value across the treasury's boundary: `Spent`, an executed spend `ProposalExecuted`, `TrancheReleased`, `MilestoneReleased`, `UnclaimedSwept`, `Redeemed`, `NavRedeemed`, `DistributionDeposited` and `RoundPaid`. Each row carries `kind`, `direction` (out or in, from the treasury), `asset` (quote or coin, never summed together), `amount`, `counterparty`, `reference` and `team_outflow`.

- `team_outflow` is true for exactly the three outflows the program's own `guard_team_outflow` covers (an allowance spend, an executed spend proposal, a revenue tranche; `programs/treasury/src/ext.rs`). It is not an inference about who a wallet is. Whether a counterparty is an insider is the question of the layer that holds the insider list, which reads `counterparty` from here.
- `TrancheReleased` names no destination, so its `counterparty` is null rather than guessed. An executed spend proposal takes its destination from `treasury_proposals`, a milestone its beneficiary from `treasury_grants`. A zero-amount milestone and a NAV-window proposal move nothing and write no row. An event the index cannot attribute to a treasury is written to `treasury_events` with a warning, as before, and has no movement.
- One function, `movementOf`, decides what an event means. The live path (`treasury.ts`) calls it in the same database transaction as the event insert; `backfillTreasuryMovements` replays stored events through the same function, with keyset pages so events that mean nothing cannot stall it, and runs after the migrations on every start. A test deletes every movement, replays, and compares the rows field by field.
- Readers: `listTreasuryMovements` (newest first, keyset `before`, filters), `listMovementsAfter` (oldest first after an id, for an alert builder that remembers the last id it handled), `treasuryMovementTotals`, `latestMovementId`. Bad input is a `RangeError` before any SQL runs and every value is a parameter. `id` is a `BIGSERIAL` in ingestion order; one indexer process writes one transaction at a time, so a later id never commits before an earlier one. A deployment with more than one writer would have to give this up.

**MCP drafts.** `oc_draft_open_fixed_price_presale` and `oc_draft_open_futarchy_dao` post to the existing `POST /v1/tx/open-fixed-price-presale` and `POST /v1/tx/seed-futarchy-dao` routes. Their schemas are as strict as the routes' `only(...)` lists, including the nested `terms` and `settings`, so there is no price argument: the price is the clearing price. The futarchy tool is not named `..._seed_...` because the server's own name guard rejects any tool name containing "seed", a guard meant for seed phrases.

## Alternatives considered

- A `team` flag derived from the treasury's authority. Rejected: the program does not call every flow from the authority (a milestone is cranked by anyone), and the event for a tranche names no destination, so the flag would be a guess.
- Movements computed at read time from `treasury_events`. Rejected: three of the nine events need a lookup in another table, which a filter on counterparty or amount cannot index.
- One row per cross in `settle_venues` for the DAO and the tranche. Rejected for the reason above: it would drop the second DAO or tranche.

## Consequences

The two tables and the movement table are classified in the disaster-recovery map (`chain` for the first two, `derived` for the movements). Until `cross_settle` batch 2 is deployed (H27) the first two stay empty on devnet; nothing here runs against a cluster, and the status of X3 and B4 stays PARTIAL on that. The API routes that expose these readers are a separate change in `services/api`.
