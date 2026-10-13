# W2D-D3: locked, compounding continuation design (program-enforced), proved on LiteSVM

Status: **proved on LiteSVM against the real Meteora binaries; devnet proof pending funding.** ADR-0482.

Programs: `cross_settle` (`open_dbc_pool_locked`, `claim_pol_fees`), Meteora DBC `dbcij3LW…`, DAMM v2 `cpamdpZC…`, cross_gate hook. Test: `tests/core/test/settle-locked.test.ts` (5 tests).

What the run shows:

- `open_dbc_pool_locked` refuses, with the program's own errors, a config that migrates into a non-compounding pool (`DesignNotCompounding`), leaves creator or partner liquidity unlocked (`DesignUnlockedLiquidity`), vests liquidity the settler cannot vest (`DesignPartnerVesting`) or locks less than 20% for good (`DesignLockTooLow`). The plain `open_dbc_pool` still accepts the same default config.
- A compounding design (Customizable migration fee option, Compounding, 5,000 bps, partner 30% and issuer 10% locked permanently, issuer 60% vesting over four steps) opens, trades (the curve completed in 2 swaps of 2.5e15 quote atoms), and DBC migrates it: the DAMM v2 pool's `collect_fee_mode` is 2. Positions read back from DAMM v2: the settler PDA owns the second position (permanent lock only), the issuer wallet owns the first (permanent lock plus vesting at a 6:1 ratio, partner:issuer permanent at 3:1); unlocked liquidity is at most rounding dust (below one millionth of the locked amount).
- A swap through the migrated pool (with the transfer-hook mint) earns fees; `claim_pol_fees` paid 5,999,999 atoms of token B to the issuer's account. A destination that is not the issuer's is refused (`WrongDestination`), and the issuer's own position is refused by DAMM v2 (the settler does not own it).
- The partner migration fee (2% config, creator share 50%) paid 47,951,807,228,916 atoms to the fee recipient after migration, and not before; a second withdrawal is refused by DBC. The surplus withdrawal is refused by DBC when the curve completes exactly on its threshold (no surplus accrued in this run): **a positive surplus payout was NOT exercised.**

Numbers worth knowing: compounding liquidity takes a protocol fee out of the migration amounts, so the curve needs a small supply margin (5,000,000 tokens here); DBC reports `InvalidTokenSupply` otherwise.

Not covered: a single-instruction launch (open and bind are two instructions in one transaction, `buildLaunchTransaction`); its transaction size was not measured; the migration of a pool with an allowlist-mode gate; more than one winning bidder; devnet.

Deploy impact: `cross_settle` must be extended and upgraded (see the report); clients regenerated (`open_dbc_pool` arguments are now nested `configParameters` / `poolParameters`; only `@opening-cross/adapters` calls them).
