# A1 listing types (2026-10-13)

Outcome: HUMAN. The whole path is built for the types the programs can carry; the three types that need a licensed partner are shown, say exactly what is missing, and cannot be created.

## What exists

`packages/presets/src/launch.ts` lists eight types: ownership coin, revenue-share token, existing token (reopening), tender and recurring call are `available` and each names the format preset and the optional modules (treasury, gate, oracle guard) that fit it; tokenized stock or ETF, pre-IPO exposure and real-world-asset yield are `needs-partner`, with the reason in a sentence and the human tasks that unblock them. The picker (`components/issue-wizard/listing-picker.tsx`) shows all eight; choosing a partner type shows the reason and keeps Create off (the concierge marks the first step blocked). A stock token a licensed tokenizer already issued can run a reopening auction today (an escrow cross), and the picker says so.

Tests: `packages/presets/test/launch.test.ts` (every available type names a real preset; every partner type names a reason and a task; the revenue-share text does not promise payouts the treasury program does not make). Browser: `e2e/issuer-wizard.mjs` ("a type that needs a licensed partner says what is missing", "does not pretend it can be created").

## The human step

Counsel and a licensed tokenizer or placement partner (HUMAN_TASKS H2 and HG4; HT2 for a flagship company). Until they exist the three types stay inert by design.

## Not covered

No tokenizer integration, no RWA verification, no pre-IPO structure. The product holds no licence and the page says so.
