# W2D-E3: NAV floor and redemption wall (E3, VM8)

Outcome: **BUILT-LOCAL**. Proved on LiteSVM; devnet proof pending funding. Design: ADR-0471. Build record: `W2D-treasury-build.md`.

Tests (`treasury-gov.test.ts`, "NAV floor and the redemption wall", 3 tests, and `treasury-dist.test.ts` "a late round is missed"):

- Closed until holders vote it open (`NavClosed`); then holders redeem at `floor(vault * amount / supply)` (10 quote per coin on a 10,000 vault and 1,000 coins) up to the period cap (10% of the supply at the period's start: 100 coins, then 90 in the next period against the new 900-coin supply); the cap is refused at one atom over (`NavLimit`); zero amounts and coins you do not hold are refused.
- Value per coin never falls: six odd-sized redemptions (each forcing rounding) leave `vault_after * supply_before >= vault_before * supply_after` every time. Rust property test `nav_redemption_never_dilutes` covers the same for arbitrary vaults and amounts. Mutation check: rounding up breaks it (`W2D-treasury-build.md`).
- Insiders (the authority and listed keys) are refused (`InsiderExcluded`); outsiders are not. The team's allowance is frozen while the window is open (`NavMode`); a close vote ends the window and spending resumes.
- A missed revenue round opens the window automatically and holders exit at NAV (ADR-0472).

Limits (stated in the ADR): continuous and rate limited, not batch or TWAP-triggered; insider exclusion is by key and a fresh wallet defeats it; no separate bid book.

FEATURE_STATUS.md row wanted: `| E3, VM8 NAV floor and redemption | BUILT-LOCAL, wording differs | Redemption at NAV while a window is open (holder vote, or automatically after a missed revenue round), rate limited per period, insiders excluded, team spending frozen meanwhile; value per coin never falls (property test and on-chain run) (`W2D-E3.md`) | Not batch-only and not TWAP-triggered (no price feed); insider exclusion is by key; proved on LiteSVM only, devnet pending; not audited |`
