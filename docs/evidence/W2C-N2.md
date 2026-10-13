# W2C-N2 (with N1): identity status and reachable support

Outcomes: **N1 BUILT**; **N2 HUMAN** (the whole path is built; a person must read the inbox and a response time must be one someone honours: HH2). Design: ADR-0411. Code: `services/api/src/routes/holder-support.ts`, `apps/web/src/app/support`, `components/portfolio/support-page.tsx`, `identity-status.tsx`.

N1: the identity status block (which gates on recent crosses this wallet holds a pass for, that most crosses need no check, and that the devnet attester verifies no real identity) is on `/portfolio` and `/support`. It is not in the site header: that file is not part of this workstream (the report names the one-line mount).

N2: a request gets a reference and a token, is stored, is mailed to the inbox when one is configured, and its reply appears on the page. The commitment line is "No response time is committed yet" until `SUPPORT_RESPONSE_HOURS` is set.

Tests: `services/api/test/holder-support.test.ts` (4). Browser run (`holder-pages-flow.mjs`, 390 dark, real SMTP sandbox): the commitment line promised nothing; a request got a reference, was stored, mailed, listed as open, answered through the operator route, and the reply appeared after a reload; axe clean; zero console errors.

Not covered: a real inbox; an SLA; a signed-out visitor who loses the browser (the reference is the only handle, and the page says so).
