# W2D-K4: governed treasury yield (K4)

Outcome: **NOT DOING** (OS-tagged row, decided in ADR-0476). Nothing was built and no stub exists.

Reason: a governed yield hook puts treasury funds in a lending market. That breaks the guarantee that NAV redemption and liquidation can always pay from a liquid vault, adds a CPI surface into a lender to a program that has none, and arrives before any audit (ENGINEERING_PRINCIPLES 1.2 and section 15). The conditions for revisiting it (a named lender, a hard cap on the deployed share, automatic recall when NAV mode opens or a liquidation is triggered, external audit first) are in ADR-0476. The orchestrator decides whether this stays NOT BUILT or moves to the Superseded list.

FEATURE_STATUS.md row wanted: `| K4 governed treasury yield | NOT BUILT (decided: not doing before audit, ADR-0476) | none | OS; a yield CPI conflicts with always-liquid NAV redemption and liquidation |`
