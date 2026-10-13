# ADR-0471: holder votes above the allowance and the NAV floor

Status: accepted (2026-10-13) · PRODUCT_FEATURES E1/E2, E3/VM8 · Resolves the "not in this version" list of ADR-0014

## Decision

**Votes (E1/E2).** A holder with at least `proposer_min_bps` of the supply (or the treasury authority) creates a proposal of one of three kinds: `Spend` (pay `amount` quote atoms to a named token account, above or below the allowance), `OpenNav`, `CloseNav`. Voting weight is the number of coins the voter **locks in the treasury's coin vault** until the vote ends; `reclaim_vote` returns them in any treasury state. One coin therefore votes once, and a borrowed coin cannot be returned before the tally. A proposal passes when the coins that voted are at least `quorum_bps` of the circulating supply (supply less unvested grant coins) and yes votes are strictly more than `threshold_bps` of yes plus no. After the vote and the timelock anyone executes it within a 14-day window. A spend is capped at `max_proposal_bps` of the vault at execution, goes only to the destination the proposal named, and meets the same conditions as any team outflow (no NAV mode, assignment recorded, no overdue disclosure request). Votes are for treasury events only; there is no instruction through which a vote can change product behaviour.

**NAV floor and redemption (E3/VM8).** While the NAV window is open (by an `OpenNav` vote, or automatically when a revenue round is missed, ADR-0472) any holder may burn coins for `floor(vault * amount / supply)` of the vault. That payout can never lower the value of the coins that remain (property-tested in Rust; on chain, value per coin is non-decreasing over a run of odd-sized redemptions). A per-period cap (`nav_cap_bps` of the supply at the period's start) rate-limits the exit; the treasury authority and up to four listed insider keys are excluded. While the window is open the team's allowance and tranches are frozen, so the vault holders redeem against is intact. A liquidation closes the window and the existing pro-rata redemption takes over.

## Alternatives rejected

- Snapshot voting. Solana has no cheap historical balance, so a snapshot needs a trusted indexer. Locking is trustless and costs the voter only the vote's duration.
- Quorum on total supply. Unvested grants would count against quorum while unable to vote.
- A separate NAV bid book. The standing offer at NAV is the redemption itself; a separate book adds state without adding protection.

## What this is not (honest limits)

- Redemptions are continuous and rate limited, not batched, and not triggered by a TWAP, as the PRODUCT_FEATURES wording for VM8 says. There is no price feed to run a TWAP against.
- Insider exclusion is by key. An insider who moves coins to a fresh wallet is not detected; the exclusion is a speed bump, and the mandatory lockup of team grants (ADR-0473) is the stronger control.
- Votes are not delegated and carry no time multiplier. No decision market.
- Not audited. Proved on LiteSVM (`treasury-gov.test.ts`, 8 tests). Devnet proof is pending: a vote cannot be compressed below three days, so the devnet script runs it in two phases (`tests/devnet/src/treasury-ext-proof.ts`).
