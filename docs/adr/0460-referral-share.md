# ADR-0460: A referrer's share of the protocol fee

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES W4, W6 (optional referrer, in the program). Builds on ADR-0010 and ADR-0450.

## Decision

A cross may name a referrer and a share in basis points (`referral`, at most 5,000: half). At `finalize`, the share of the **protocol's** fee goes to the referrer's token account for the quote mint; the rest goes to the fee recipient as before. The integrator's fee, every buyer's price and every seller's proceeds are untouched, and a referral never changes what any bidder pays. Fees are still charged only on filled notional, to the sell side, never on bids, cancels or refunds (ADR-0010), and the protocol fee is still the smaller of the schedule and a quarter of the integrator fee, so a referral is a share of at most 20% of a cross's total fees.

The referrer's token account is a required remaining account of `finalize` when the share and the protocol fee are both non-zero. It must be a token account of the quote mint owned by the referrer (`ReferralAccountMissing` otherwise). A referrer with no token account cannot stop a finalize: anyone may create the associated account first. The referral is fixed in the rules before the first order, like every other rule.

## Not covered

The specification's "zero-fee public-good tier" needs no code: an integrator fee of zero already gives a protocol fee of zero (`protocol ≤ integrator / 4`). A referrer registry, and referral shares on the integrator's side, are not built.

## Evidence

`tests/core/test/rules-safety.test.ts`: the referrer receives exactly its share of the protocol fee, the fee recipient the remainder, the integrator its fee; the vault ends empty; a missing or somebody else's account is refused; a referrer without a token account does not block finalize.
