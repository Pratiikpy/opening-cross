# ADR-0962: The fee ledger records the referrer's share, and statements have a referrer role

Status: accepted (2026-10-16) · Rows W4, W6 · Builds on ADR-0010 (fees), ADR-0317 (the fee ledger), ADR-0460 (the referrer's share of the protocol fee) · Code `packages/fees` (`schedule.ts`, `chain.ts`, `ledger.ts`, `statement.ts`, `referral.ts`, `policy.ts`) · Evidence `W5-1G.md`

## Context

ADR-0460 put the referrer's share in `finalize`: `referral = floor(protocol_fee x share_bps / 10,000)` goes to the referrer's quote account and `protocol_fee - referral` to the fee recipient. The `CrossFinalized` event still records the gross protocol fee. The ledger checked the finalize transaction against "the fee recipient received the whole protocol fee", so every cross that names a referrer would have been a `MISMATCH` against a correct chain, and no statement showed the referrer's income.

## Decision

1. `referralShare(protocolFee, shareBps)` mirrors `finalize` (floor; nothing when either figure is zero; a share above 5,000 bps is refused). `distributeFees` and `expectedFinalizeDistribution` return total, protocol (gross), integrator, referral and the protocol's net.
2. `CrossFeeFacts` gains optional `referrer` and `referralShareBps` (from `CrossExt.referral`; absent for a cross without rules). `ledgerEntry` expects the referrer to receive the referral and the fee recipient the rest; it adds `referrer` and `referral` to the entry. The event's gross protocol fee is still compared with the counters, so a wrong event and a wrong transfer are reported separately. A share above the cap, or a share with no referrer, is a reason, not a guess.
3. The transfer check credits the fee recipient `protocolFee - referral` and the referrer `referral`; a referrer who is also the fee recipient is checked in aggregate with every other shared wallet.
4. `totalsByMint` keeps the gross protocol fee and `referralFee` apart (the protocol's own take is the difference). `allocateAll` counts the referral a cross paid itself as a referral out of the gross fee.
5. Statements: the `protocol` role shows what the fee recipient was paid (net of the referral); `integrator` and `issuer` are unchanged (the referral moves nothing on their side); the `referrer` role, which already existed for the router, now also has one line per cross for the on-chain referral, MATCH only once the finalize transaction's balances agree. `referrerStatementWithRouter` puts the on-chain lines and the router's per-order lines in one document.
6. **One protocol fee never pays two referrals.** `referralLines` (the off-chain router's per-order 10%) returns nothing for a cross that names a referrer on chain (`ReferralCross.referralShareBps`).

## Alternatives rejected

- Recording the referral as a new field of the event: a program change for a figure derivable from two fields the event already carries.
- Folding the referral into `integratorFee`: the referral comes out of the protocol's fee only (ADR-0460), and an integrator's statement must not move.

## Consequences

Callers that build `CrossFeeFacts` must pass the two fields or a referral cross reads as a `MISMATCH`: `services/api/src/routes/fees.ts` does not yet (it does not read the cross's rules tail), and passes neither `referralShareBps` to `referralLines` nor uses `referrerStatementWithRouter`. That is the one change outside this package that completes the row (listed in `W5-1G.md`). `LedgerEntry` and `Totals` gained fields; nothing was removed.

## Evidence

`packages/fees/test/referral-onchain.test.ts` (25), including the figures the real program produced in LiteSVM (`tests/core/test/rules-safety.test.ts`), 20,000 seeded cases of the rounding property, every atom accounted for over 5,000 seeded fee splits in all three supply modes, and the MISMATCH cases. And the real thing: `services/keeper/scripts/referral-proof.ts` finalized three crosses with non-zero fees and two referrals on a validator running the real `cross_core` binary, and the ledger returned MATCH for each on the real transactions and events.
