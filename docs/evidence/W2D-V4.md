# W2D-V4: tender, unlock and block-sale crosses, flagship offering (V4, V7, V6, R8)

Outcome: **HUMAN** for V4, V6 and R8; **BUILT-LOCAL** for the V7 mechanism. Design: ADR-0461, ADR-0462, ADR-0476 (treasury side).

V4: an escrow cross of kind `Tender` with a gate: only listed holders can offer, the issuer's single bid clears the cheapest offers first, the unsold is returned (`rules-stocks.test.ts`). Securities counsel decides the offer-period rules, exemptions, who may be offered and what is filed, and a placement partner is needed (H2, HS4, HG4). V7: a locked fill vests, is released and sold in a reopen (same test file). V6, R8: the program parts exist (gate, identity limits, classes, neutrality, guards, treasury); the company, counsel, partner and KYC provider are the founder's (H1, H2, H8, HT2).

FEATURE_STATUS.md rows wanted: `| V4 tender crosses | HUMAN | Escrow cross of kind Tender with a gate, cheapest offers first, unsold returned (`W2D-V4.md`, ADR-0461) | Counsel and a placement partner decide what is allowed (H2, HS4, HG4) |` and `| V7 unlock and block-sale crosses | BUILT-LOCAL | Vested lock release sold through a reopen cross (`W2D-V4.md`) | No lockup or collateral integration with a real issuer or lender |`
