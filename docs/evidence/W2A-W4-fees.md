# W2A-W4, W6: fee, referral and revenue accounting over the live protocol

Rows: W4, W6 (fees; referral and fee accounting). Date: 2026-10-13. Code: `services/api/src/routes/fees.ts` (`registerFees`), `services/indexer/migrations/010_referrals.sql`, `packages/fees` (unchanged library; one product added to the proposed rate card), tests `services/api/test/fees.test.ts` (4), live script `services/api/scripts/fees-devnet.ts`.

## What stays in the program, and what cannot be there today

In `cross_core` (unchanged, ADR-0010, proved on devnet in `C2-cross-core-devnet.md`): the schedule (`Protocol.fee_bps`, indexed by kind), its snapshot into each cross at creation (the schedule entry capped at a quarter of the integrator fee), who pays and when (the seller in an escrow cross, the issuer at finalize in a minting cross), the rule that no bid, cancel or refund pays a fee, and the split of the vault at finalize between the protocol fee recipient, the integrator and the proceeds recipient.

Not in the program, and therefore accounting plus a transfer from whoever holds the fee wallet: the optional 10% referrer share (the cross has no referrer field), the 25% rebate pool for registered market makers on reopens, the issuer subscription and the listing fee. A program-side referrer needs a new account field and instruction in `cross_core`, which is a change for the programs workstream (listed as "needs program"). `GET /v1/fees/schedule` states exactly this split in its response.

## What the routes do

- `GET /v1/fees/schedule` reads the Protocol account.
- `GET /v1/fees/ledger` builds one line per finalized cross from three sources that must agree to the atom: the cross account's counters run through the program's fee rules, the `CrossFinalized` event the indexer recorded, and the token balance changes of the finalize transaction as the cluster reports them. MATCH needs all three. A line whose transaction cannot be read is UNVERIFIED and is not counted, and is not remembered either: the next request reads it again. A disagreement is MISMATCH with the reason.
- `POST /v1/referrals` stores a referral document only if the referred wallet signed it. `GET /v1/fees/referrals/:referrer` computes what is owed per order (10% of the protocol's share of what each referred order paid; floors per order so the sum never exceeds 10% of the cross's protocol fee) and says it is "owed", not paid. `GET /v1/fees/allocation` shows where the matched protocol fees go: referrals, the reopen rebate pool, the rest.
- `GET /v1/fees/statement/:role/:party` returns a statement signed by the configured attestation key, or the unsigned body with a stated reason when none is configured.

## Evidence

Tests (real encoded accounts, a real database, finalize balances built to be exactly what finalize does): a MATCH line; a recorded fee that disagrees with the counters is MISMATCH naming the protocol fee; a finalize transaction altered by one atom is MISMATCH naming the chain; a missing transaction and a rate-limited fetch are UNVERIFIED, counted apart, and the busy one becomes MATCH on the next request; a forged referral is refused; one referred seller's order gives `protocolFeeShare` 77,500 and `payout` 7,750 on a 155,000,000 sale at 25 bps with a 5 bps protocol share; the allocation's referral figure equals the payouts and `gross = referrals + rebate pool + operating`, with the rebate pool exactly 25% of the protocol fee on a reopen; a signed statement verifies against the published signer and fails when the party is changed.

Real data: the ingestion path read the devnet market-maker cross (`W2A-X6-marketmaker.md`) and the route produced, for it, `verdict: MATCH`, protocol fee 0, integrator fee 0, proceeds 3000 (the dust bond returned to the proceeds recipient), reading the finalize transaction `55cNJ5MZBcX5b395BzrrnvbihjaaLQNwvPsY5nyhnjivHc5pJdzRViPipEojQWC6hg96dFbVk9FJLgYRxXuqU7Zt` from the cluster. That cross was created with a zero fee, so what this proves against the chain is the structure of the check and the 3000-atom proceeds transfer, not a non-zero fee: **NOT VERIFIED for a non-zero fee on a real chain** (no devnet cross has charged one since the schedule was proposed; the test uses constructed balances).

## Not covered

Referral payouts on a real cross (no devnet order was referred); a payment record for referrals (the route says "owed" and nothing marks a payout paid); the web app's revenue page (not part of this change); the deployed API, which does not carry these routes until `registerFees` is wired into `services/api/src/server.ts`.
