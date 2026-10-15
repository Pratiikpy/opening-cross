# ADR-0804: The backing attester states a figure from a configured source, and ages out on failure

Status: accepted (2026-10-15). Builds on ADR-0655.

## Decision

`services/backing-attester` signs the statements `cross_backing` checks. A source is configured per asset: reserve token accounts read from chain, an HTTPS JSON report (headers from the environment), or a report file. It posts only a figure the source gave, dated and fresh; it refreshes at half the maximum age, skips a change below `minChangeBps` inside `minIntervalSecs`, and holds a figure above `maxIncreaseFactor` times the last for an operator.

A source that fails is not worked around: the attester says nothing, the statement ages out, and `check` halts the asset. Silence is the safe direction. The service proves nothing about a custodian; which attesters count is an operator decision (H32).
