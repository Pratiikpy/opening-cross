# ADR-0475: the disclosure feed and the IP and asset assignment gate

Status: accepted (2026-10-13) · PRODUCT_FEATURES E5, E6

## Disclosure feed (E5, on-chain parts)

The team posts a disclosure (`post_disclosure(hash)`: the hash of the published report) as often as it likes; each post is an event and a counter. A holder with at least `request_min_bps` of the supply may request one (`request_disclosure`); the first open request starts a clock of `disclosure_period_secs` and later requests do not restart it. A post clears the request. While a request is **overdue** (the deadline has passed with no post) every team outflow is refused (`DisclosureOverdue`): allowance spends, executed spend proposals and tranches. "Mandatory" is therefore enforced by the one lever the program has, the money. Holders still have the NAV vote as an exit. The hash commits to a document; the program cannot check what the document says. The monthly cadence in the row is a convention for the team and the front end; the program enforces only the answer to a holder's request.

## Assignment gate (E6)

A treasury extended with `assign_required` refuses every team outflow until `record_assignment` has been called with a live SAS attestation for the treasury under the assignment credential and schema named at extension, written by counsel or a notary. The program checks that the attestation exists; it does not and cannot check what it means. The attestation is read once; its later expiry does not undo the record. Counsel's step is a human task (`HT1`): drafting the assignment, signing it and issuing the attestation. Everything on chain is built and proved on LiteSVM (`treasury-grants.test.ts`).
