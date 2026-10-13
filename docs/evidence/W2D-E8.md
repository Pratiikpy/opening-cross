# W2D-E8: automated pro-rata stablecoin distributions (E8)

Outcome: **BUILT-LOCAL**, wording differs (holders opt in by staking). Proved on LiteSVM; devnet proof pending funding. Design: ADR-0472. Build record: `W2D-treasury-build.md`.

Tests (`treasury-dist.test.ts`, "distributions to staked coins" 5 tests and "streamed distributions" 4 tests, all passing):

- A 1,000 deposit is shared 400:100 between two stakers exactly; a staker who arrives after a deposit gets none of it and a share of the next; claims leave the distribution vault at zero; a second claim is refused (`NothingToClaim`).
- Unstaking settles the reward first and re-staking neither loses nor duplicates it (300 + 100, then 100 + 100 + 100 over three deposits with the stake changing in between).
- A deposit made while nobody is staked waits and goes to the first staker, even one atom of stake.
- 40 random stake, unstake, deposit and claim operations across three holders: after every step `coin_vault = votes + staked + grants` and the distribution vault covers every settled reward plus the unreleased stream; at the end paid + remainder = deposited exactly and the remainder is under 200 atoms (rounding dust). Rust property test `distributions_never_overpay` covers arbitrary stakes and deposits.
- Streaming over 7 days: half way through, exactly half of a 400 deposit (200) has been released, shared 150 and 50 between stakers holding 300 and 100; a coin staked one minute around a deposit earns under 0.1% of what it would have caught at once and the rest reaches the stakers who stayed; a second deposit merges into the stream and nothing is created or lost; a stream shorter than an hour is refused.
- Zero amounts, other people's positions, over-unstaking, a holder with no coins; deposits and stakes during liquidation are refused while unstake, claim and redeem work.

Not built: payment to wallets that did not stake; a payer-side batch push; indexer, API and UI for stakes and distributions.

FEATURE_STATUS.md row wanted: `| E8 automated pro-rata stablecoin distributions | BUILT-LOCAL, wording differs | Stake coins, anyone deposits quote tokens, rewards stream to stakers by an exact accumulator; exits never blocked; JIT staking earns a block's share (ADR-0472; `W2D-E8.md`) | Holders must stake to be paid; no push to other wallets; no UI; LiteSVM only, devnet pending; not audited |`
