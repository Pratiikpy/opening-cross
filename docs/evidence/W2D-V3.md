# W2D-V3: verified-revenue rounds, tranches and distributions (V3, Y6)

Outcome: **HUMAN** (program path built; the revenue source and its attester are the one thing left). Proved on LiteSVM; devnet proof pending funding. Design: ADR-0472. Build record: `W2D-treasury-build.md`.

Tests (`treasury-dist.test.ts`, "verified-revenue rounds", 5 tests; `treasury-ext.test.ts`; `treasury-compute.test.ts`):

- Round 0 pays 10% of an attested 5,000 revenue into the stakers' pot once the round is over (`RoundOpen` before), exactly once; the stakers claim 375 and 125; marking a paid round missed is refused.
- The share rounds up (10% of one atom is one atom); a zero-revenue attestation is a paid round of nothing; no attestation (`NotAttested`), an attestation for another round (`WrongAttestationAccount`), an expired attestation and a payer who cannot cover it are refused; data that is not a u64 is refused even when the schema lets it through (`BadRevenueData`; SAS itself already refuses a mismatched layout when the schema is `[3]`).
- A round not paid within the grace period is missed: at the deadline itself marking is refused (`RoundNotLate`), after it paying is refused (`RoundClosed`) and anyone marks it; the NAV window opens, holders exit at NAV and the team's allowance freezes.
- A tranche releases once per paid round whose revenue met the bar; below the bar, twice, from a non-authority, for a round that does not exist, for a missed round, and in NAV mode are all refused.
- Revenue clocks that start in the past are refused at extension.

The human step is `HT3`: a payment-processor reader with read access to the company's account must write one SAS attestation per round at `getRevenueRoundNonce(treasury, round)` with data `encodeRevenueAttestation(revenue)`, signed by the credential named in the treasury. Those two helpers are in `@opening-cross/treasury-client`. The reader service is not in this repository. The revenue path is **NOT VERIFIED against a real revenue source**; a real attester is trusted for the figure.

FEATURE_STATUS.md rows wanted:
`| V3, Y6 verified-revenue tranches | HUMAN | Revenue rounds read from SAS attestations (u64 revenue per round), the holders' share paid by anyone into the stakers' pot, a missed round opening the NAV exit, and tranches released once per qualifying round (ADR-0472; `W2D-V3.md`) | A payment-processor reader that writes the attestations is not built (HT3); the attester is trusted for the figure; no zk proof; LiteSVM only, devnet pending |`
