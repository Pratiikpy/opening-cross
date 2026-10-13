# W2A-O1: the public dashboard's data (`GET /v1/dashboard`)

Date: 2026-10-13. Code: `services/api/src/routes/dashboard.ts`; tests: `services/api/test/dashboard.test.ts` (3), and `test/w2a.test.ts` (3) for the registration of all W2A route groups together.

## What it is

One route that computes nothing. Each section is the answer of a route that already exists, fetched through the server itself, with that route named beside it: health, totals, execution quality, fairness (without its long per-cross list), external flow, the signed-promise accuracy record, the fee ledger totals, the protocol (paused, fee recipient, schedule), the rating track record, and the five programs read from chain (when each was last deployed and who may upgrade it). A section whose route fails or is not enabled on a deployment says so with the reason; it is never filled with a default. Results are reused for 15 seconds. The web page that draws this is the web workstream's; this is the data it should read.

## Tests

The program state is read from a hand-built upgradeable program and its ProgramData account (deployed slot, upgrade authority, revoked authority, a program that is not upgradeable, one that is not deployed). A small server with some routes working, one failing with a 500, and several absent: the working sections carry their route as `source`, the failing one reports `answered HTTP 500: rpc busy`, the absent ones `this route is not enabled on this deployment`; the long per-cross list is dropped; a second request inside the lifetime is the same answer without another round of reads; `skip` leaves sections out.

## Run on real data

`scripts/dashboard-devnet.ts` forwards the section routes to the deployed devnet API (`https://98-87-59-136.sslip.io`) and reads the programs from devnet. Result: health (`ok`, indexer 9 seconds behind), totals (64 printed of 112 crosses, 59 buyers filled, 30 without a price), execution quality, fairness, external flow and the accuracy record (50 and 70 promises issued in the first two buckets) all came back with their own method text; the five programs were read: `cross_core` last deployed at slot 510565333, upgrade authority `DTB3Jtxb...` (the ops key, so not yet handed to a multisig, HUMAN_TASKS H13 and H18), `cross_gate` at slot 510089600. The three sections served by routes the deployed API does not have yet (fees ledger, fee schedule, rating track record) correctly read "not enabled on this deployment": the deployed API predates these routes.

## Not covered

No chart or page. Mainnet figures: none exist. `codeBytes` is reported as `allocatedBytes` because ProgramData is allocated larger than the program (700,000 bytes for `cross_core`) and the real size is not stored in it. The deployed API does not yet carry the W2A routes, so the full dashboard has not run against a deployment.
