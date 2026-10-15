# ADR-0803: Keeper duties for the new programs: on only when they are safe

Status: accepted (2026-10-15). Builds on ADR-0703 (the earlier optional duties).

## Decision

`graduation` (finalize a round whose window closed; publish a passed round's outcome in the same pass) and `backing` (`check` an opted-in asset) are on by default: each acts only when the program says it will succeed, and with no program on the cluster there is nothing to find. `listings` (release or slash) and `bounties` (claim a broken invariant) are named only: a slash may fund the venue's slash account, and a bounty claim pays the keeper's own wallet, so an operator chooses them.

Planning is pure and unit tested (`planGraduation`, `planListing`, `planBounty`, `planBacking`); an action is skipped when the chain no longer needs it, so a restart or a second keeper repeats nothing, and `KEEPER_DRY_RUN` plans without sending. A scoped keeper narrows graduation and listings to its creators' crosses.
