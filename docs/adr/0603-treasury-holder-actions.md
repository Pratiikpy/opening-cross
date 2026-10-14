# ADR-0603: Holder actions of the treasury extension

Status: accepted (2026-10-14). Builds on ADR-0471 to ADR-0475, ADR-0505 and ADR-0600.

## Decision

The treasury page shows holder actions only when the deployed treasury program has the extension (`/v1/programs`), the treasury was extended (`/ext`), and the team switched the feature on. Otherwise it says which of the three is missing and offers nothing.

Vote (yes or no, with the coins to lock), reclaim a finished vote, execute a passed proposal, stake and unstake, claim distributions, mark a late revenue round missed, release a grant milestone, burn an expired grant, and request a disclosure are each a transaction built by the W3A route and signed in the holder's wallet.

Redemption at NAV is shown in two steps: the API builds the transaction and reports the payout with the vault and supply, the holder reads it, and the page builds again at signing and stops if the payout changed. The page does not duplicate the program's arithmetic.

Rights cards already omit extension cards for a treasury that was not extended; a note above them says whether the extension is deployed.

## Not covered

Creating a proposal, depositing a distribution, paying a round and creating a grant (team and depositor actions, not holder actions) have no screen here. Revenue rounds are claimed through the distribution the paid round feeds.
