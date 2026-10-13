# A8 launch simulator (2026-10-13)

Outcome: BUILT for demand, clearing, float, value and fees. Liquidity after the cross is NOT modelled (no pool read exists in the API); the page says so.

## What exists

`apps/web/src/lib/issuer-sim.ts`, the panel in the wizard and `/issuer/simulator` (ADR-0352).

## Checks

- `apps/web/test/issuer-sim.test.ts` (20 tests): the price, matched quantity and rationed side equal the independent verifier's `referenceClear` on 600 random books; a joining bid's fill equals `referenceFills` on 300 random books; the minimum-volume and imbalance guards are strict and ordered as OCIP-1 section 7.7; fees follow section 7.6; a 9-decimal token works.
- `apps/web/test/issuer-fees.test.ts`: the fee maths equals `packages/fees` for every kind and every integrator fee from 0 to 300.
- `apps/web/test/issuer-guards.test.ts`: the imbalance band the page states (for 50%: demand between 67% and 150% of supply) is true at its edges when simulated.
- Browser (`e2e/issuer-wizard.mjs`, `e2e/issuer-console.mjs`): 800 tokens of demand at 1.50 against 1,000 offered at 1.20 clears at 1.2 for 800; half the demand does not print because it is under the float minimum; double the demand is stopped by a 50% imbalance limit and prints once the limit is cleared; a draft's soft commits (400 tokens at 1.50 against 300 offered) clear at 1.5 for 300, as the rule requires (the price rises until demand above it fits).
- The protocol fee schedule on screen is read from the chain through the new `GET /v1/issuer/protocol`: launch 30, reopen 5, tender 15, recurring 30 basis points, from the Protocol account on devnet.

Screens: `docs/evidence/screens/w2b/wizard-02-simulator.png`, `console-06-simulator.png`, and the `visual/simulator-*` set.

## Not covered

- Liquidity after the cross (pool depth, price impact): the API has no read of pool state.
- The oracle guard: its verdict depends on a Pyth update that does not exist in advance.
- A confidence interval or any forecast: the three scenarios are half, once and twice the demand entered, and are labelled so.
- Retail outcome beyond the fill of one more bid at chosen limits.
