# ADR-0750: Recurring series, halts and corporate actions as screens

Status: accepted (2026-10-14). Builds on ADR-0455, ADR-0456, ADR-0462, ADR-0600 and ADR-0701.

## Decision

Two public pages and two issuer pages carry the series and the halt states. `/series` and `/series/:address` show every series, its schedule, whether the next cross can be spawned now, and how each spawned cross ended, with the reason in words when it did not print. `/halts/:mint` shows whether a token is halted, by whom, since when, what lifts it, and its lender print feed. `/issuer/series` creates a series, opens one, pauses and resumes it and withdraws from it; `/issuer/halts` creates a halt state, halts, flags and clears a corporate action, copies a pause, feeds the circuit breaker and runs the print feed. The calendar lists the series; a cross page says it belongs to a series and, when it honours a halt that is up, says so above the tabs.

The page states what the program will do, from the program's own rules: the next close is `next_close` (the first interval slot strictly after now and the last close, or the calendar's next session), a cross is spawned at most 24 hours before it opens, crosses run one at a time, a missed slot is skipped. `spawnVerdict` mirrors `spawn_next` and is tested slot by slot; the API and the program still check again, and the dry run before signing catches any difference. Anyone may spawn. Only the authority pauses and withdraws, and the page shows those controls only to it.

A halt is lifted only by a printing resume cross. The halt console says so and offers nothing that pretends otherwise: Halt is off when the token is halted, a venue signer cannot flag a corporate action, a wallet with no role can only copy a pause or feed the breaker, which anyone may.

A page that reads one thing by address asks the list first (`/v1/series`), so an address that is not a series is a sentence on the page and not a 404 in the console.

## Not covered

No screen lifts a halt: that is a resume cross, opened from the issue wizard with its rules step. `observe_price` takes a Pyth update account typed by the person; nothing here builds one. A series on a calendar is spawned only when the calendar's sessions can be read.
