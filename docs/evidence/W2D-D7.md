# W2D-D7: DBC partner payouts (HD4 claim_partner_fee), proved on LiteSVM

Status: **proved on LiteSVM against the real DBC binary; devnet proof pending funding.** ADR-0480, ADR-0481. Test: `tests/core/test/settle-partner.test.ts` (4 tests) and the post-migration test in `settle-locked.test.ts`.

- A 100,000,000-atom buy on a live pool at 1% fee accrued 1,000,000 atoms of fees; `claim_partner_fee` paid the partner's share exactly to the fee recipient's quote account and left the creator's share (40%) in the pool; the settler PDA held nothing before or after.
- A second claim paid nothing. A destination (quote or base) owned by anyone but the fee recipient is refused with `WrongDestination`. A pool of another cross is refused (the config PDA is pinned to the cross).
- Partner surplus and migration-fee withdrawals are refused by DBC before the curve completes; the adapter refuses destinations not owned by `proceeds_to` / the fee recipient.
- Compute: the claim fits in one instruction; stack frames were split (`#[inline(never)]`) after the first version overflowed the SBF stack.

Not covered: the creator-side bridge to a fee-sharing vault (the creator signs for itself; no new program code), claim of the pool-creation fee (built, not exercised: the test config has a zero creation fee), a positive partner surplus.
