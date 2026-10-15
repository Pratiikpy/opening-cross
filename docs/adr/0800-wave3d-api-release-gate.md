# ADR-0800: API routes for programs that are not deployed refuse cleanly

Status: accepted (2026-10-15). Builds on ADR-0650 to ADR-0656, ADR-0663 and ADR-0700.

## Decision

Every transaction route of the seven Wave 3D programs reads the cluster before it builds: the program account, then its ProgramData scanned for the instruction discriminator (`lddw` bytes, as `loadsDiscriminator` does for the extended programs). A program that is absent, or lacks the instruction, answers 409 `PROGRAM_NOT_DEPLOYED` with the program, its name and the instruction. A cluster that cannot be read, or a scan that cannot find the control instruction, is `unknown`: the route builds with `release.deployed: null` and is never told it is missing. A missing answer is cached for 20 seconds only, so a deployment is seen quickly; a present answer is cached as the existing gate does.

Reads answer with `release.deployed` and a note instead of an error where a list is meant, and 404 `PROGRAM_NOT_DEPLOYED` for one account that cannot exist. `GET /v1/programs` gains the seven programs and a `features` map (mandates, conviction, baskets, listing, bounty, backing, governedGraduation, fixedPricePresale, futarchyDao) so a screen offers only what the cluster can run.

Creating a cross with the governed-graduation flag is refused while its seeding could never succeed (cross_graduate or the batch 2 gate definitely missing), and each seeding route applies the program's own gate: the cross's `Outcome` account must exist and name the venue (409 `GRADUATION_NOT_APPROVED`, why `NO_OUTCOME` or `WRONG_VENUE`).

Refusals use the program's own error name in SNAKE_CASE as the `reason`, with every refusal found in `issues`, so a screen branches on a name that is also in the IDL and in the diagnose tables.
