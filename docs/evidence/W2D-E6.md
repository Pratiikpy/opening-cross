# W2D-E6: IP and asset assignment gate (E6)

Outcome: **HUMAN** (code path built; counsel's step is the one thing left). Proved on LiteSVM; devnet proof pending funding. Design: ADR-0475. Build record: `W2D-treasury-build.md`.

Built: a treasury extended with `assign_required` refuses every team outflow (allowance spend, executed spend proposal, tranche) until `record_assignment` has been called with a live SAS attestation for the treasury under the assignment credential and schema chosen at extension.

Tests (`treasury-grants.test.ts`, "IP and asset assignment gate", 2 tests): spend is refused before (`AssignmentRequired`); recording is refused with no attestation (`NotAttested`), with a wrong account (`WrongAttestationAccount`) and with the treasury's own spend attestation, which is under another schema, so it cannot stand in for counsel's; with counsel's attestation anyone records it and the spend then works; recording twice is refused (`AlreadyAssigned`); on a treasury without the requirement it is refused (`Disabled`). A holder-approved spend is held back by the same gate (`treasury-gov.test.ts`).

The human step is `HT1` in `docs/HUMAN_TASKS.md`: counsel drafts and signs the assignment, and a notary or counsel issues the SAS attestation with nonce equal to the treasury address. The program checks that the attestation exists, not what it says.

FEATURE_STATUS.md row wanted: `| E6 IP and asset assignment | HUMAN | Spend gate on a recorded assignment attestation (ADR-0475; `W2D-E6.md`) | Counsel drafts the assignment and issues the attestation (HT1); the program cannot judge its content; LiteSVM only, devnet pending |`
