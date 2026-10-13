# ADR-0355: Guards are explained in plain words, the accepted amount is shown as a range, and the oracle guard carries a warning

Status: accepted (2026-10-13)

## Context

W8 (print guards) and B5 (the issuer chooses the accepted amount within published rules) exist in the program as `min_matched`, `max_imbalance_bps` and the oracle guard. The console had them as three bare fields. Two traps follow from the rules: an imbalance limit counts unmet demand, so a tight one stops an oversubscribed sale from printing, which is usually the outcome an issuer wants; and a cross with an oracle guard cannot clear without a verified Pyth price in the clearing transaction (OCIP-1 section 7.8: `OracleAccountMissing`, and the cross stays live), while the hosted keeper has no Pyth key yet.

## Decision

- Each guard sits beside a sentence saying what the program does with it, and the sentence is computed from the value: an imbalance limit of x is shown as the band of demand-over-supply it lets print, 1/(1+x) to 1+x, and a test runs the rule at the band's edges.
- A minimum volume above the supply the issuer lists fails readiness, because the cross could never print. No minimum is allowed and gets a warning that a thin sale would print.
- Accepted amount (B5) is shown before signing as a range: the fewest tokens that let the cross print (the effective minimum volume, including any float rule, ADR-0351) and the most (the supply listed in a minting cross). A raise target in quote tokens becomes a minimum volume at the issuer's lowest price, rounded up so the raise is never below the target.
- The oracle guard has its fields (feed id, difference limit, price age), validated to the API's rules, and a standing warning: a price update must accompany the clearing transaction or the cross cannot clear. It is on the readiness list as a warning, not a pass.

## Not done

- Refunds that need no claim (B5 asks for pushed refunds) need a program change: refunds are claimed by a permissionless crank today.
- The issuer cannot choose an accepted amount after seeing the clearing: the program has no instruction for it. The range above is the choice available before.
