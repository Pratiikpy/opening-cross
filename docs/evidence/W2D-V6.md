# W2D-V6: flagship real-company offering, treasury side (V6, R8)

Outcome: **HUMAN** (every program part that can exist does; the rest are people, counsel and a company). Design: ADR-0476. Build record: `W2D-treasury-build.md`.

Built: the treasury features a flagship needs (assignment gate, disclosure feed, revenue rounds with a missed-round exit, holder votes and NAV, milestone team tokens, wind-down) and `flagshipExtParams` in `@opening-cross/treasury-client`, a reviewable parameter set (7-day vote, 2-day timelock, 20% quorum, 365-day team lockup, monthly revenue rounds, 35-day disclosure deadline, assignment required, 365-day wind-down). The test `treasury-ext.test.ts` "flagship preset" shows the program accepts it as written and records every protection in the tail.

Left, and only a person can do it (see `docs/HUMAN_TASKS.md` H1, H2, H8, HT1 to HT3, HI1 to HI3): choose and incorporate the company, obtain counsel's opinion on the coin, gate presets and rights card, engage a funding portal or placement partner, have a KYC provider write identity attestations, and connect a payment-processor reader. The preset is a proposal for counsel, not legal advice. No company has agreed to anything.

FEATURE_STATUS.md row wanted: `| V6, R8 flagship real-company IPO | HUMAN | All treasury-side program parts (ADR-0470 to ADR-0475) and a reviewable parameter preset (`flagshipExtParams`, ADR-0476; `W2D-V6.md`) | The company, counsel, a funding portal or placement partner, a KYC provider and a revenue reader (H1, H2, H8, HT1 to HT3, HI1 to HI3) |`
