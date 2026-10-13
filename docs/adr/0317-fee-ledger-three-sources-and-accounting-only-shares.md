# ADR-0317: A fee line is verified by three sources; referral and rebate shares are accounting

Status: accepted (2026-10-13) · Rows W4, W6, P3 to P5 · Code `services/api/src/routes/fees.ts`, `packages/fees` · Evidence `W2A-W4-fees.md`

## Decision

1. **A finalized cross's fee line is MATCH only when three sources agree to the atom**: the cross account's counters run through the program's fee rules, the `CrossFinalized` event, and the token balance changes of the finalize transaction as the cluster reports them. A line whose transaction cannot be read is UNVERIFIED and is never summed; a disagreement is MISMATCH and is shown.
2. **The program's fee rules are stated, not re-invented**: the schedule per kind snapshotted at creation (capped at a quarter of the integrator fee), the seller pays in an escrow cross and the issuer at finalize in a minting one, no bid, cancel or refund pays a fee.
3. **What the program cannot do is accounting and a transfer by whoever holds the fee wallet**: the 10% referrer share (the cross has no referrer field), the 25% rebate pool, the issuer subscription and the listing fee. These are computed exactly (integer arithmetic) and stated as figures, never as payments that happened.
4. **A referral is a document signed by the referred wallet**, revocable by a later one, effective from a stated time; payouts owed to a referrer are listed per order.
5. **Statements are signed by the attestation key when configured** and say they are unsigned when not.

## Alternatives rejected

- Trusting the cross counters alone: a bug in the counters would be invisible.
- Calling a computed share a payout: nothing moves it.

## Consequences

A program-side referrer needs a new account field and instruction (needs-program). Non-zero fees were not seen on a real chain: devnet crosses charged 0 bps in the sampled runs.
