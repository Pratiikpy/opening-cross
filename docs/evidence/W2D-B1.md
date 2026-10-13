# W2D-B1: reserve and tick rules (B1, VM1)

Outcome: **BUILT-LOCAL**. Design: ADR-0451.

`FLAG_STANDARD_GRID` with a published `grid_estimate`: `set_rules` refuses a grid whose first price is below half the estimate, whose tick exceeds one percent of it, or that does not contain it (`GridPolicy`). Without the flag the issuer's free grid is unchanged. Tests: `rules-guards.test.ts` (accepted; refused for a low reserve, a coarse tick, and a grid that misses the estimate).

FEATURE_STATUS.md row wanted (replace the Gap text of the B1, VM1, VM6 row): `The 0.5x reserve and 1% tick rules are enforced for crosses created with `FLAG_STANDARD_GRID` (`W2D-B1.md`); crosses without the flag keep the issuer's free grid up to 256 ticks; the sniper figure is still a model result`
