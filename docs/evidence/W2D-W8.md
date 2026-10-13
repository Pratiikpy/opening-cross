# W2D-W8: print guards and the no-print fallback (W8)

Outcome: **BUILT-LOCAL**, wording differs. Design: ADR-0451, ADR-0452, ADR-0455, ADR-0459.

Built: no print when matched volume is below the minimum, the imbalance is above the maximum, the raise, float, valuation or price-move bound is missed, the oracle diverges or is unavailable or the oracles disagree, the mint is paused, a halt or a corporate action is flagged, or a scaled-UI multiplier changed; one drawn extension then "no cross" with the reason in `no_print_reason`; a lender price feed that only a publisher's sufficiently large print can move ("a thin cross never feeds lenders"); a halt flag (ADR-0455).

Tests: `rules-guards.test.ts` (18), `rules-safety.test.ts`, `rules-oracle.test.ts` (11), `rules-ending.test.ts` (extension), `rules-stocks.test.ts`.

The "VRF extension" is a block-hash draw (ADR-0452), not a VRF: there is none on devnet.

FEATURE_STATUS.md row wanted: `| W8 print guards | BUILT-LOCAL, wording differs | Minimum volume, imbalance, raise, float, valuation, price move, oracle median and spread, paused mint, halt, corporate action and scaled-UI multiplier guards; one drawn extension then no cross; lender print feed; 40+ LiteSVM tests (`W2D-W8.md`, ADR-0451, 0452, 0455, 0459) | The extension is drawn from block hashes, not a VRF; the feed has no lender integration; devnet proof pending funding; not audited |`
