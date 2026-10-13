# ADR-0407: Retention, measured by cohort

Status: accepted (2026-10-13)

Row R6

## Context

"Investor retention loops measured by cohort retention" needs the measurement before any loop can claim an effect.

## Decision

`GET /v1/metrics/retention`: wallets are cohorted by the week their first cross opened; a wallet is retained in week k if it ordered in a cross opening k weeks later; only completed weeks are reported; creators and `OWN_WALLETS` are excluded; a cohort under five wallets shows counts and no percentage. The page `/retention` publishes it with the method. The loops themselves are the alerts, the follow list, the claim and refund notifications and the receipt: none claims an effect. The figures are devnet test traffic and say so.
