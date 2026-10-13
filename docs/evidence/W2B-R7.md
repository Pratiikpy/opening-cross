# R7 STAMP / accelerator pipeline (2026-10-13)

Outcome: HUMAN. The pipeline page and the application path are built; a partnership with an accelerator is a human step. Nothing about STAMP's own mechanics is claimed: the repository holds only the Colosseum site's mention of it, and nothing here implements it.

## What exists

`/issuer/accelerators` (`components/issuer/accelerators.tsx`, `lib/issuer-pipeline.ts`, 2 tests): how a company from a program raises (draft listing, wizard, application naming its program), and a public pipeline of applications that name a program or cohort, grouped by the name the applicants typed (apart from case and spacing), with the latest decision on each. The application form has an optional cohort field. The page says in a boxed note that there is no partnership behind it and that the cohort is the applicant's unverified statement.

Browser (`e2e/issuer-console.mjs`, run 5): an application naming "Example Accelerator" appeared in the pipeline under that name; the note about no partnership is on the page.

## The human step

Agree with Colosseum and Superteam how cohort membership is verified (for example a signature from the program's key) and what a cohort raise gets, then replace the unverified claim with that. Counsel needed for any STAMP structure (H2).

## Not covered

STAMP itself; any treatment of a cohort different from other issuers; MetaDAO listing paths.
