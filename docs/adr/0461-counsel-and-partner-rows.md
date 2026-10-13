# ADR-0461: Rows that end in a human step

Status: accepted (2026-10-13). Covers PRODUCT_FEATURES V4, V6 and R8 on the `cross_core` side. The treasury side is ADR-0476.

## Decision

These rows are built as far as the program can go and end in a step only the founder can take. Nothing below is a legal conclusion.

| Row | What is built | The human step |
|---|---|---|
| V4 tender and secondary crosses | An escrow cross of kind `Tender`, a gate with an allowlist, the order window, pro-rata at the margin and the return of the unsold (`rules-stocks.test.ts`). | Securities counsel decides which offer-period rules and exemptions apply, who may be offered, what is filed (HUMAN_TASKS H2, HS4); a placement partner (HG4). |
| V7 unlock and block-sale crosses | Locked fills that vest and release, sold into a reopen; a holder's block as a large sell in an escrow cross (ADR-0462). | A lockup or collateral integration with a real issuer or lender. |
| V6, R8 flagship real-company IPO | A cross with an allowlist gate, identity limits and classes (ADR-0453), insider neutrality and a bond (ADR-0454), print guards (ADR-0451), the treasury (ADR-0476). | Choose the company, incorporate the issuer and the holder entity, counsel's opinion, a funding portal or placement partner, a KYC provider (HUMAN_TASKS H1, H2, H8, HT2). |

The arbiter that rules on insider challenges (ADR-0454) is a person or a body: naming it is HUMAN_TASKS H28.
