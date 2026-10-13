# ADR-0414: Auto-invest mandates and conviction reputation are not built on the web side first

Status: accepted (2026-10-13)

Rows S4, J2, S7.

## Context

Both rows promise something the chain must enforce. A mandate's limits and kill switch are worth nothing if a server holds them; a conviction badge is worth nothing if it can be earned without the holding it claims to measure.

Options considered for each:

| Option | Why not |
|---|---|
| A bot with an off-chain policy, a "kill switch" that is a database flag | The limits would be a promise by the operator, which is what the specification rules out ("onchain") |
| A score computed from balance snapshots | A balance read cannot show that tokens were held throughout; it rewards timing |
| A new program for each, with the web side after it | Chosen |

## Decision

Neither row is built in the web or mobile app until its program exists. The exact programs are specified in `docs/evidence/W2C-S4.md` (a `cross_mandate` program: a PDA that owns the orders and a vault that is the budget, so a limit cannot be exceeded by construction, and an owner-only revoke and withdraw) and `docs/evidence/W2C-S7.md` (a lock vault and a non-transferable Token-2022 badge measured in token-days). Both leave `cross_core` unchanged.

## Consequences

The rows stay open in FEATURE_STATUS as needs-program. Nothing on the site implies either exists.
