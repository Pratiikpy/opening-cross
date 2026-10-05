# ADR-0006: Meteora DBC continuation adapter (`cross_settle`, flagship adapter)

Date: 2026-10-05 · Status: accepted · Builds on ADR-0004, ADR-0005 and devnet proofs DP1–DP6, DP8

## Goal
A launch clears once at the uniform price P\*, winners receive their allocation at P\*, and the token then keeps trading on a Meteora Dynamic Bonding Curve that **starts at P\*** and later graduates to DAMM v2. The cross sets the opening price; DBC supplies continuous liquidity afterwards.

## Constraints established by source and devnet
- DBC fixes a pool's start price (`sqrt_start_price`) in its config, so the config can only be written once P\* is known, i.e. after the clear.
- DBC creates the base mint inside pool initialisation and gives its mint authority to the config's `fee_claimer` only for transfer-hook configs (`PartnerUpdateAndMintAuthority`).
- Minting outside the curve does not disturb DBC's reserves, price or migration (DP1, DP2, DP6); the mint authority can be revoked afterwards (DP4).
- DBC removes the hook at graduation (findings §2), so the hook can gate and lock only during the curve.

## Decision
**Programs.** `cross_core` gains a *deferred base mint* variant of mint mode: a launch cross is created with only a quote mint and the issuer's supply schedule; buyers bid in quote. A new adapter program, `cross_settle`, is the only party allowed to bind the base mint after the clear (its PDA is recorded on the cross as `settler`).

**Settlement transaction(s), permissionless after the clear:**
1. `cross_settle::open_dbc_continuation` derives the price, then CPIs into DBC:
   - `create_config_with_transfer_hook` with the config PDA as signer, `fee_claimer` = the adapter's per-cross PDA, `transfer_hook_program` = `cross_gate`, and the issuer's pre-committed curve shape (stored at cross creation, never chosen by the cranker). The adapter **rejects** any config whose `sqrt_start_price` differs from `isqrt(P* · 2¹²⁸ / price_scale)` by more than 1 (invariant 10: pool seeded at P\* within one unit in the last place).
   - `initialize_virtual_pool_with_token2022_transfer_hook` with the base-mint PDA as signer. DBC hands the mint authority to the adapter PDA.
2. The adapter, now mint authority, creates the `cross_gate` config in `Open` mode for this mint and writes the hook meta list (curve trading is open to everyone; gated assets use ADR-0004 instead).
3. The adapter moves the mint authority to the cross PDA and CPIs `cross_core::bind_base_mint`, which checks that the cross PDA holds the authority and records the mint.
4. Claims mint each winner's fill at P\*; `finalize` revokes the mint authority for good and pays the issuer.

**Who sets what.** The issuer commits to the curve shape, migration threshold, fees and liquidity split when creating the cross; the cranker can only trigger the steps. The start price comes from the clear, never from a caller.

## Consequences
- Settlement may need two or three transactions (DBC config and pool initialisation are account-heavy). Each step is idempotent and checks the previous one, so a stalled settlement can be resumed by anyone; until the mint is bound, claims and finalize refuse to run and refunds remain available through the no-print path if settlement is abandoned past a deadline.
- The DBC SDK cannot resolve our owner-seeded hook accounts (findings §1); the TypeScript SDK resolves them itself.
- Measurements for DP3 (compute units and accounts per step) are recorded when the adapter lands.
