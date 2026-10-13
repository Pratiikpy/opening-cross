# W8 print guards UI: minimum volume, imbalance, oracle (2026-10-13)

Outcome: BUILT for the explanations, the controls and the validation. The oracle guard's operation on the hosted stack is HUMAN (a Pyth key and a keeper that posts the price).

## What exists

`lib/issuer-guards.ts` (`guardNotes`, `checkOracle`), `components/issue-wizard/guards-panel.tsx`, `lib/issuer-wizard.ts` (`ruleChecks`). Each guard has a sentence computed from its value: no minimum warns that a thin sale prints; a minimum above the supply is blocked; an imbalance limit shows the band of demand it lets print and warns that a tight one stops an oversubscribed sale; the oracle guard has its three fields validated to the API's rules and a standing warning that a verified Pyth price must accompany the clearing transaction or the cross cannot clear and stays open (OCIP-1 section 7.8).

Tests: `issuer-guards.test.ts` (19), `issuer-wizard.test.ts` (23), `issuer-sim.test.ts` (20). Browser: a tight imbalance limit warns (`guard-imbalance` severity warn); the simulator shows the oversubscribed case stopped by it and printing when it is cleared; a minimum above supply fails readiness.

## The human step

The hosted keeper has no Pyth key (HUMAN_TASKS H11, HS3), so an oracle-guarded cross created from the console could not be cleared by it. The page warns and lists the guard as a warning, not a pass. Create one only with a keeper you control. NOT VERIFIED on devnet: an oracle-guarded cross created from the wizard and cleared with a real price update (DP15 proves the pull path for BTC/USD separately).

## Not covered

A calendar-bound oracle guard (the calendar field is the stocks workstream's); VRF extension and halt flags (not built in the program).
