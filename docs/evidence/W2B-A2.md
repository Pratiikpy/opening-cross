# A2 application and curation with a published readiness checklist (2026-10-13)

Outcome: HUMAN. The path is built end to end. Reviewers must be named, and the proposed criteria confirmed or changed, by people.

## What exists

- `/issuer/apply`: the published checklist (ten items the console checks by itself, each by the wizard's readiness id; seven a reviewer looks at, marked as proposed), the limits of a review, a wallet-signed application, the applicant's status, and a review queue shown only to a wallet named a reviewer.
- `services/api/src/routes/issuer-board.ts` and `issuer-signed.ts` (ADR-0353): signed records, with `application` and `decision` kinds; a decision is accepted only from a wallet in `ISSUER_CURATORS`; the latest decision wins.
- Tests: `services/api/test/issuer-board.test.ts` (21, against PGlite, a real Postgres): refusals (not acknowledged, bad listing type, unsafe link, a missing draft, 21 checks), a decision by a non-curator, the case of no curators ("No curators are configured"), the latest decision wins, the cohort claim kept as typed. `apps/web/test/issuer-review.test.ts`: every automatic criterion on the page is a readiness item the wizard really produces.

## Run

`apps/web/e2e/issuer-console.mjs` (devnet wallet, local API with the issuer wallet named as the only reviewer): the checklist is on the page without a wallet; the reviewer sees the queue; Submit stays off until the acknowledgement is ticked; the application is signed and stored; the reviewer's "changes requested" decision appears on the applicant's application. Screen: `console-07-apply.png`.

## The human step

Name the reviewers (generate keys; set `ISSUER_CURATORS` on the API) and confirm or change the proposed criteria in `apps/web/src/lib/issuer-review.ts`. Until then applications are stored and public and the page says nothing can be decided.

## Not covered

No identity or KYB check of an applicant (A4). Self-reported checks are not attached to an application. A reviewer's decision is advisory: nothing in a program gates on it.
