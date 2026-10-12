# D1: DAMM v2 permanent lock and compounding fee mode

Date: 2026-10-13. Code: `packages/adapters/src/damm.ts` (`buildLockDammPosition`, `DammCollectFeeMode.Compounding`, `compoundingFeeBps`). Test: `tests/core/test/damm.test.ts`. Decision: ADR-0022.

Environment: LiteSVM loading the real cp-amm 0.2.5 binary (`tests/fixtures/cp_amm.so`, Meteora's deployed program). Run: `node node_modules/vitest/vitest.mjs run test/damm.test.ts` in `tests/core` under WSL. Result: **6 passed** (2 existing seeding tests, 4 new).

| Check | Result |
|---|---|
| The discriminator our builder derives for `permanent_lock_position` equals the one in Meteora's IDL | equal |
| After seeding, the position holds 101,036,978,438,429,870,000,000,000 unlocked liquidity; after the lock, `permanent_locked_liquidity` equals that amount, `unlocked_liquidity` is 0, and the pool's `permanent_lock_liquidity` equals it | all equal |
| A wallet that does not own the position NFT cannot lock it; locking more liquidity than the position holds is refused; the locked amount stays 0 after both | refused |
| Compounding pool opens at exactly P* (pool `sqrt_price` equals the adapter's value) with `collect_fee_mode` 2 | equal |
| One swap of 100,000,000 base through a plain pool and a compounding pool (5000 bps): claimable fee per liquidity 3,169,789,340,510,736 vs 1,584,896,354,541,875 (49.99% of plain) | half stays in the reserves |
| Compounding pool keeps all 100,000,000 input in its reserves (`token_a_amount` 5,100,000,000) and its liquidity is unchanged | equal |

### Vesting schedule (Meteora's `lock_position`, `refresh_vesting`, `remove_liquidity`)

`buildVestDammPosition` puts the opening liquidity under a schedule: here 20% at a 7-day cliff, then 20% every 7 days for 4 periods (total 101,036,978,438,429,870,000,000,000 liquidity, tranches of 20,207,395,687,685,970,000,000,000).

| Check | Result |
|---|---|
| After `lock_position`, the whole position is `vested_liquidity` and `unlocked_liquidity` is 0 | equal |
| Before the cliff, Meteora's `remove_liquidity` of 1 unit is refused (`InsufficientLiquidity`) | refused |
| One second after the cliff, `refresh_vesting` unlocks exactly the cliff tranche; withdrawing it succeeds and raises the issuer's base balance | equal |
| Withdrawing 1 unit more is refused | refused |
| One period later, `refresh_vesting` unlocks exactly one more tranche, no more | equal |

## NOT covered

- Devnet: no transaction. The devnet faucet and every public alternative were exhausted (airdrop returns 429; other RPCs need keys), and the operator wallet holds under 0.01 SOL. The same instructions need one devnet run when SOL exists.
- The permanent lock was proven for the full opening position of one pool; a partial permanent lock was not run. Vesting was proven for the whole position with a cliff and weekly periods; schedules with no cliff were not.
- Compounding with a nonzero dynamic fee, and `claim_position_fee` after a lock, were not exercised.
