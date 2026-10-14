# W3D-S5: basket token (`cross_basket`), proved on LiteSVM

Status 2026-10-14: **program, client and tests built; proved on LiteSVM with a legacy share mint and mixed legacy and Token-2022 components; not deployed (H27).** Not audited. ADR-0652. Row S5 (the cohort index itself is `W2C-T1.md`).

## What was built

A new program `4uNyZ4fSihcnrqASfYHCC35edh3EdndP37jSWqWQZxCp` (263,424 bytes), 3 instructions (`create_basket`, `mint_shares`, `redeem_shares`), 3 events, 9 errors, and the client `@opening-cross/cross-basket-client`.

A basket has one to eight components, each an amount per whole share, and a six-decimal share mint whose authority is the basket PDA. Minting pays `ceil(units x shares / 10^6)` of every component into the basket's vaults; redeeming burns shares and pays `floor(...)`. No manager, fee, rebalance or pause; a basket never changes. After every mint and redemption each vault must cover the outstanding shares (`Insolvent` otherwise).

## Tests

- `tests/core/test/basket.test.ts`: **10 passed**. A deposit of 1.5 shares costs 3,000,000 + 750,000 + 11 (10.5 rounded up) and the redemption returns 3,000,000 + 750,000 + 10, leaving one atom; the smallest share atom costs 2 + 1 + 1 and returns 2 + 0 + 0; a donation of 5,000,000 atoms to a vault does not change the price of a share; a user short of one component moves nothing (atomic); the basket creator cannot mint shares directly and no user can redeem more than they hold; **60 random mints and redemptions by three users** keep every vault at or above what the shares are owed after every step, and after redeeming everything no user holds more of any component than they paid in. Creation refuses a duplicate component, a zero amount, no component, a 33-byte label, nine components, a vault that is not the basket's account, a non-mint, and mints with a transfer fee or a permanent delegate. A swapped, foreign or missing token account is refused.
- `cargo test -p cross_basket`: **4 passed** (deposits round up and redemptions down, a round trip never returns more than was paid, coverage is exact at the boundary).
- Mutation checks: deposit rounding up -> down: 3 tests fail; redemption rounding down -> up: 3 fail (the solvency check fires); the extension whitelist widened to a transfer fee and a permanent delegate: 1 fails; the vault derivation check removed: 1 fails.
- `cargo fmt --check`, `cargo clippy -D warnings`: clean.

## Compute units (LiteSVM, three components)

create_basket 93,203 (with the vault account creations in the same transaction) · mint_shares 37,399 · redeem_shares 35,954.

## Size and deploy cost

263,424 bytes; program account rent 1.339 SOL (permanent) and a returned buffer.

## Not covered

Devnet; a basket of tokens with a transfer hook (refused; **tokens gated by `cross_gate` cannot be components**), a transfer fee or other restricting extensions (refused by design); a component with a freeze authority can have the basket's vault frozen by its issuer and stop redemptions (accepted, stated in ADR-0652); more than about five components in one transaction needs an address lookup table (not exercised); an audit.

## FEATURE_STATUS row wanted

`| S5 cohort index | PARTIAL | The index is built (`W2C-T1.md`); a `cross_basket` program makes a basket token: a share backed by fixed amounts of up to eight tokens, minted and redeemed against the vaults by anyone, rounding in the basket's favour and the vault cover checked after every step; 10 LiteSVM tests including 60 random operations and 4 unit tests (`W3D-S5.md`, ADR-0652) | Not deployed (H27); no SDK builders, API route, indexer projection or basket page; gated (transfer-hook) tokens cannot be components; not audited |`

## What the app layers must add

SDK: builders for the three instructions; the remaining accounts are three per component (mint, the basket's vault, the user's account), the fixed accounts include both token programs (`tests/core/test/basket.test.ts` has the reference). Indexer: project `BasketCreated`, `SharesMinted`, `SharesRedeemed` and the `Basket` account. API: a basket read (components, vault balances, supply, backing per share) and unsigned-transaction routes. Web and mobile: a basket page (components, a mint and redeem ticket showing the exact rounding). The cohort index can name a basket as its tradable form. Diagnose: add the 9 errors.
