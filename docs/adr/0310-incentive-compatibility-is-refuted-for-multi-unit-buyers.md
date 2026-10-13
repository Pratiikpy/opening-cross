# ADR-0310: The clearing rule is not strategy-proof for a buyer with several units; this is stated, not hidden

Status: accepted (2026-10-13) · Row Q2 · Amends the incentive claim in ADR-0003 · Evidence `W2A-Q2-adversarial.md` · Code `tools/simulator/opening_cross_sim/adversary.py`

## Decision

1. **Treat the incentive-compatibility claim of ADR-0003 as refuted for a buyer with more than one unit of demand.** A hand-checkable book exists (sellers 50 at 100 and 50 at 150; a small buyer 40 at 200; a strategic buyer valuing 50 units at 200 and 50 at 190): honest bidding clears at 190 and earns 500; bidding 160 and 150 clears at 150 and earns 2,900. It is the usual demand-reduction property of uniform-price auctions.
2. **Do not claim truthful bidding is a best response** anywhere (ADR-0003 and OCIP-1 §7.3 now say refuted for multi-unit buyers, not proven for single-unit buyers).
3. **Keep the adversary search in the repository** (demand reduction, issuer shilling, uninformed sniping) so the claim is re-checked when the rule or its guards change. On 400 seeded books a four-block buyer gained by deviating in 60.5% (median 11% of its honest surplus); issuer shilling helped in 1.25%; sniping helped in 4.5% and hurt in 67.8%.
4. **Test single instructions with Mollusk against the built binary** (`tests/mollusk`, a separate workspace on a newer compiler), in addition to the LiteSVM flows.

## What is not decided

Whether to cap or split large orders, accept the property and disclose it, or change the rule is a product decision (HUMAN_TASKS). The search is a lower bound on manipulation and assumes populations nobody has observed.

## Consequences

A feature that relies on honest bidding (for example a price promise whose calibration assumes sincere demand) must say so. The sealed call reduces what a strategic bidder can learn about others, which the search does not model.
