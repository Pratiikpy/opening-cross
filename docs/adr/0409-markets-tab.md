# ADR-0409: Markets tab and the cohort index

Status: accepted (2026-10-13)

Rows T1, S5

## Context

Between crosses a token has no price except the last one it cleared at.

## Decision

`/markets` lists every token that has printed, with its last clearing price and day, matched amount, number of prints and next cross, the premium monitor's reading of tokenized stocks (premium and status only: raw reference prices are not shown, HUMAN_TASKS H15), and a cohort index: for tokens that cleared more than once in the same quote token, the equal-weighted mean of latest over first clearing price, published only when at least three tokens qualify (one token's price is not an index). Today fewer than three do, so the page says so. A tradeable basket token would be a program and is not built.
