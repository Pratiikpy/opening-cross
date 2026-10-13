# W2D-E1: holder votes above the allowance (E1, E2)

Outcome: **BUILT-LOCAL**. Proved on LiteSVM; devnet proof pending funding. Design: ADR-0471. Build record: `W2D-treasury-build.md`.

Tests (`tests/core/test/treasury-gov.test.ts`, "holder votes above the allowance", 5 tests, all passing):

- A passed proposal spends 4,000 of a 10,000 vault (allowance 1,000 per period) after the three-day vote and the one-day timelock; early execution is refused (`TimelockPending`) both while voting and during the timelock; voting after the end is refused (`VotingClosed`); a second execution is refused (`AlreadyExecuted`); voters get their locked coins back and a second reclaim finds no record; the coin vault ends empty and `votes_locked` returns to zero.
- Refused: no quorum (10% of a 20% bar), a tie (quorum met, not a strict majority), more than `max_proposal_bps` of the vault (`OverProposalCap`), a majority against, a changed destination (`WrongDestination`), execution after the 14-day window (`ProposalExpired`).
- Refused: a proposal from a non-holder (`NotHolder`), the wrong id, zero amount, a NAV kind with an amount, a disabled feature, zero votes, voting coins you hold none of, voting more than you hold, early reclaim (`VotingOpen`).
- A holder-approved spend is still held back by the assignment gate; execution is refused once the treasury is liquidating, and voters can still reclaim and redeem.

Limits: no delegation; quorum and majority only; one spend per proposal. Votes cannot change product behaviour (no such instruction). The vote, the timelock and the execution window cannot be compressed on devnet; `treasury-ext-proof.ts` runs it in two phases, four days apart.

FEATURE_STATUS.md row wanted: `| E1, E2 holder-governed treasury | BUILT-LOCAL | Proposals to spend above the allowance and to open or close a NAV window; coin-locking votes, quorum, strict majority, timelock, per-proposal cap, destination fixed at proposal time (ADR-0471); 8 LiteSVM tests with E3 (`W2D-E1.md`) | Proved on LiteSVM only; devnet proof pending the treasury upgrade and funding; no delegation; not audited |`
