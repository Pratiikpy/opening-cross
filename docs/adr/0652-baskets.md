# ADR-0652: Baskets are a program, `cross_basket` (S5, K3)

Status: accepted (2026-10-14)

## Context

[S5, K3] "Cohort index and baskets of cross-cleared assets": the index itself is built (`W2C-T1.md`); a basket **token** needs a program, because a token that stands for several tokens is only worth holding if anyone can redeem it for them.

## Decision

A new program, `cross_basket`. A basket is created once by anyone (`["basket", creator, id]`), with one to eight components, each an amount of a token per whole share (10^6 share atoms), and a share mint (`["share", basket]`, legacy SPL Token for the widest wallet and DEX support, six decimals, mint authority the basket PDA).

- `mint_shares(shares)`: the depositor pays `ceil(units * shares / 10^6)` of every component into the basket's vaults (associated token accounts of the basket PDA) and receives the shares. `redeem_shares(shares)`: the shares are burned and `floor(units * shares / 10^6)` of every component is paid out. Rounding always favours the basket.
- **No manager, no fee, no rebalance, no pause, no way to change a basket after creation.** The share is the sum of its parts. A donation to a vault changes nothing about the price of a share, because the ratio is defined by the components, not by vault balances (so there is no inflation or donation attack).
- After every mint and every redemption the program checks that each vault covers what the outstanding shares are owed (`Insolvent` otherwise): the invariant is enforced, not only argued. A mint measures the vault's balance before and after the transfer.
- Components must behave like plain tokens: legacy SPL Token mints, or Token-2022 mints whose only extensions are display ones (metadata, groups, scaled or interest-bearing UI amounts). A transfer fee, a permanent delegate, a transfer hook, a pausable, confidential-transfer, default-state or non-transferable extension is refused at creation (`UnsafeExtension`), because it would make the backing unprovable. **Tokens gated by `cross_gate` use a transfer hook and therefore cannot be components**; a basket of gated assets would need a hook-aware version.
- A component with a freeze authority (a stablecoin) is allowed: the issuer could freeze the basket's vault and stop redemptions. This is stated in the evidence file; the program cannot remove it.

## Consequences

- Program id `4uNyZ4fSihcnrqASfYHCC35edh3EdndP37jSWqWQZxCp`, client `@opening-cross/cross-basket-client`, 3 instructions, 3 events, 9 errors.
- A transaction that touches more than about five components needs an address lookup table (three accounts per component plus six fixed).
- The app layers add the basket page, the indexer projection of the three events and an API read; the cohort index (`W2C-T1`) can name a basket as its tradable form.
