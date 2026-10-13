# W2D-W4: referral share in the program (W4, W6)

Outcome: **BUILT-LOCAL**. Design: ADR-0460.

A cross may name a referrer and a share (at most half) of the **protocol** fee, paid at `finalize` to the referrer's quote token account; the integrator's fee and every bidder's price are untouched; fees stay on filled notional only, never on bids, cancels or refunds (ADR-0010). Tests (`rules-safety.test.ts`): the referrer receives exactly its share, the fee recipient the rest, the integrator its full fee, the vault ends empty; the account missing or someone else's is refused; a referrer without a token account cannot block a finalize.

FEATURE_STATUS.md row wanted (the W4, W6 fees row, Gap column): `The optional referrer share (up to half of the protocol fee) is in the program (`W2D-W4.md`, ADR-0460); there is still no separate `cross_fees` program; the figures remain proposals (HD1)`
