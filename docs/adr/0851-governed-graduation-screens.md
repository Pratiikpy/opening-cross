# ADR-0851: Governed graduation on the cross page, the issuer console and the settle page

Status: accepted (2026-10-15) · Builds on ADR-0656, ADR-0657, ADR-0663

## Decision

- **Rule flag.** The fifth rule flag (`FLAG_GOVERNED_GRADUATION`, `1 << 5`) is a field of the issuer's rules form (`governedGraduation`), a preset ("Graduation by holder vote") and a check in the rules step, with the program's own conditions in its hint: set before the first order, never changed, refused by the API while `cross_graduate` or the batch 2 build of `cross_settle` is missing. `GOVERNED_GRADUATION_FLAG` sits beside `FLAGS` rather than in it because the API's parity test pins those four.
- **The vote, on the cross.** A cross whose rules carry the flag has a Graduation tab: the charter, every round with its tally and share, the quorum against the live supply, why a round is short (quorum, organic volume, majority), and the actions each person may take: vote (a stake can grow but never change venue), post the volume (the charter's attester), finalize and publish (anyone), take the tokens back after the window. The mint-authority warning appears wherever holders are asked to vote.
- **The creator's console.** `/issuer/graduation` sets the charter (bounds checked before a transaction exists) and opens each round, and says when the program would refuse: a cross that already took orders, one that is not finalized, a token that can still be minted.
- **The settle page follows the vote.** For a governed cross every graduation venue (DAMM v2, DLMM, Raydium, the MetaDAO DAO) is off until a vote passes, and afterwards only the venue holders chose is on, each with the reason. The DBC continuation and the fixed-price tranche are not graduation venues (ADR-0656, ADR-0663) and are not gated.
- **The tranche and the DAO.** The tranche's price is not typed: the API pins `q_price` to the clearing price and the page shows what a full sale brings in. The DAO's quote deposit is not typed either: it is the exact ratio rounded up, shown beside the base amount. MetaDAO takes legacy SPL Token mints and a six-decimal quote only; the page says so for a Token-2022 cross instead of offering a button the adapter would refuse.

## Not covered

The wizard's rules step was changed (one check, one preset) but its browser suites were not re-run; the unit tests of the rules form and of the flag were.
