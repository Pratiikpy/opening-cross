# ADR-0022: DAMM v2 pools open locked and compounding

Status: accepted (2026-10-13)

## Context

`seed_damm_v2` opens a full-range DAMM v2 pool at exactly P* (ADR-0005, evidence `A2`). Two properties of a fair first market were missing: the opening depth could be withdrawn by the issuer the next block, and the pool could only collect its fee in the plain modes. FEATURE_STATUS row D1/X17 listed both as gaps.

## Decision

Use Meteora's own instructions and parameters rather than re-implement them.

1. **Permanent lock.** `buildLockDammPosition` builds cp-amm's `permanent_lock_position` for the cross's position. The creator owns the position NFT and signs, so the instruction goes in the same transaction as `seed_damm_v2`; from the pool's first block the opening liquidity cannot be withdrawn. No change to `cross_settle` was needed, which keeps the deployed program and its account layout untouched.
2. **Vesting.** `buildVestDammPosition` builds cp-amm's `lock_position` for an issuer who wants the opening depth released in tranches (a cliff, then equal periods) instead of locked forever; `refresh_vesting` and `remove_liquidity` are Meteora's own.
3. **Compounding fee mode.** `DammCollectFeeMode.Compounding` (cp-amm value 2) and `compoundingFeeBps` are passed through `InitializeCustomizablePoolParameters`. With `compoundingFeeBps` = 5000, half of every fee stays inside the pool's reserves instead of being claimable by the position.

## Consequences

- The lock is irreversible by design; the builder says so and the issuer must opt in by sending it.
- Proven against the real cp-amm binary in LiteSVM (`tests/core/test/damm.test.ts`, 5 tests): the discriminator the builder derives equals the IDL's, all unlocked liquidity moves to the permanent lock, a non-owner and an over-sized lock are refused, and a compounding pool leaves exactly half the claimable fee a plain pool accrues for the same swap.
- NOT VERIFIED on devnet: no devnet SOL was available (faucet exhausted). The evidence file names this.
