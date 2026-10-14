# ADR-0663: A fixed-price tranche at the clearing price through Meteora's Presale Vault (B4)

Status: accepted (2026-10-14)

## Context

PRODUCT_FEATURES [B4]: "Fixed-price presale mode via Meteora Presale Vault (base supply minted by partner authority before revoke: proved on devnet, DP11; not integrated into a cross)." `DP11-presale-vault.md` proved on devnet that Meteora's Presale Vault, created in fixed-price mode, takes the whole supply into its own vault, survives a revoke of the mint authority and sells at its price to the end. What was missing is the link to a cross: where the price comes from.

## Decision

A new `cross_settle` instruction, `open_fixed_price_presale`: after a cross prints P*, the creator opens a fixed-price presale of more of the token, a tranche for everyone who did not bid in the call, whose price is **the price the call discovered**. The adapter makes two calls into Meteora's `presale` program (`initialize_fixed_price_presale_args`, then `initialize_presale`) and pins the one thing only it can: `q_price` (quote atoms per base atom as a Q64.64 number) equals `floor(P* x 2^64 / price_scale)`. The caps, times, vesting and registries are the creator's, validated by the presale program, and the presale program itself moves the supply from the creator's token account into its vault. The presale must be in fixed-price mode (`PresaleNotFixedPrice` otherwise), and only the cross's creator can open one.

This is the only fixed-price sale of the token that carries the cross's guarantee: the creator cannot pick a different price afterwards. A creator can still make any presale by hand; it is not the cross's tranche and the product does not present it as one.

## Why an adapter and not a cross kind

The cross itself already sells at a fixed price when its grid has one tick, so a "fixed-price cross" needs no program. The Presale Vault adds Meteora's own vault, its escrows, its vesting, and its place in Meteora's app: what a Meteora-native issuer expects. The price pin is what keeps it honest.

## What is proved and what is not

LiteSVM runs the real mainnet Presale binary: the presale is created, the supply moves into its vault, and a price one unit off in either direction, another presale mode and a non-creator are refused. The buyer's side (deposit, claim at the price, the creator's withdrawal, the unsold refund) is Meteora's program and was proved on devnet in DP11; this ADR does not re-prove it. A Token-2022 base with a transfer hook needs its hook accounts passed as remaining accounts with the matching `RemainingAccountsInfo` (the `hook` argument carries its Borsh encoding); that path is built and not exercised.

## Consequences

- `cross_settle` grows (by about 37 KB with the presale interface, `idls/presale.json`, from `@meteora-ag/presale` 0.1.1, interface only), one instruction, one event (`FixedPricePresaleOpened`), one error (`PresaleNotFixedPrice`, code 6031).
- The adapters package and the console add the builder and the choice of caps and times.
