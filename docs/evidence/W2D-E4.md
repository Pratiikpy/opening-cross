# W2D-E4: milestone team tokens with a minimum lockup; earn-out and carve-out terms (E4, A6)

Outcome: **BUILT-LOCAL**. Proved on LiteSVM; devnet proof pending funding. Design: ADR-0473. Build record: `W2D-treasury-build.md`.

Tests (`treasury-grants.test.ts`, first block, 4 tests, all passing):

- A grant of 100 coins (carve-out 25%, earn-out 50%, the rest unassigned) escrows the coins; nothing releases before the lockup (`MilestoneNotReady`); after it anyone cranks the carve-out to the beneficiary; the earn-out is refused without its attestation (`NotAttested`), with the wrong account (`WrongAttestationAccount`), to someone else's coin account (`WrongBeneficiary`) and for a milestone that does not exist (`GrantInvalid`); with the attestation it releases; a milestone releases once (`AlreadyReleased`); after the expiry the unearned 25 coins are burned (supply falls by exactly that) and a second burn is refused. `coin_vault = votes + staked + unvested` holds after every step.
- An earn-out never attested is burned whole at expiry.
- Refused at creation: a lockup under the treasury's minimum (`LockupTooShort`), milestones over 100%, a zero-share milestone, no milestones, an expiry not after the lockup, an empty grant, the wrong id, a non-authority creator, escrowing more than the team holds; an attestation that lapsed no longer releases an earn-out.
- A liquidation excludes unvested grants from the redemption snapshot (900 of 1,000 coins), refuses further releases (`Liquidating`), lets anyone burn the forfeited coins, and the four holders then redeem the whole vault to within 3 atoms.

A6 reading: the carve-out and the burnable earn-out are the "founder-fair" templates; no other term exists. Limits: the attester of an earn-out is trusted; the minimum lockup is the team's parameter.

FEATURE_STATUS.md rows wanted:
`| E4 milestone team tokens | BUILT-LOCAL | Grants escrowed in the treasury with a program-enforced minimum lockup, carve-out and attested earn-out milestones, burn of the unearned rest, forfeit on liquidation (ADR-0473; `W2D-E4.md`) | The earn-out attester is trusted; proved on LiteSVM only, devnet pending; not audited |`
`| A6 founder-fair terms | BUILT-LOCAL | The carve-out and earn-out grant templates above | No other template; same limits |`
