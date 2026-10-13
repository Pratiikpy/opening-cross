# ADR-0316: The backtester replays history through the verifier's reference clearing, and checks its own baseline

Status: accepted (2026-10-13) · Rows L4, X16 · Code `packages/backtester` · Evidence `W2A-L4-stream-backtester.md`

## Decision

1. **A strategy is replayed against a recorded book through the independent reference clearing** (`referenceClear` in `packages/verifier`), the same rule the program runs, not a model of it.
2. **Every replay starts from a baseline check.** The recorded cross's own orders are cleared; the result must equal the recorded clearing price and matched volume. The check is three-valued (match, mismatch, cannot be checked because the cross has no base mint), and a mismatch invalidates the run.
3. **The data are real.** The fixture is live data from the deployed API; the live run on 86 crosses matched the recorded outcome in 86 of 86 (7 skipped for lack of a base mint).
4. **A strategy cannot see the future.** It receives the book as it stood and returns orders; fills come from the clearing.
5. **A market-maker strategy reuses the bot's quote builder** (`buildQuote`), so what is tested is what runs.

## Alternatives rejected

- A closed-form model of fills: the pro-rata margin and the rounding are exactly where models diverge (a hand-computed 1.55 was not a valid clearing price; the rule gave 1.60).
- Backtesting without a baseline: a silent mismatch would produce a convincing wrong result.

## Consequences

History is devnet history: mostly operator test traffic. A backtest says what a strategy would have done on those books, not on a market.
