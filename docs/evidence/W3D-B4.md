# W3D-B4: a fixed-price tranche at the clearing price (`open_fixed_price_presale` in `cross_settle`), proved on LiteSVM

Status 2026-10-14: **instruction, client and tests built; proved on LiteSVM against the real mainnet Meteora Presale Vault binary; not deployed (H27, batch 2).** Not audited. ADR-0663. Row B4.

## What was built

`open_fixed_price_presale(args, q_price, disable_withdraw, hook)` in `cross_settle`: two calls into Meteora's `presale` program after a cross prints P*, with the vault's `q_price` pinned to `floor(P* x 2^64 / price_scale)` and the presale required to be in fixed-price mode, signed by the cross's creator. The interface is `idls/presale.json` (Presale Vault v0.1.1, interface only, called at `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj`).

## Tests

- `tests/core/test/presale-tranche.test.ts`: **2 passed** against the real `presale.so`: the presale account is created and owned by the presale program and the supply (500 tokens) leaves the creator's account and sits in the presale's base vault; a `q_price` one unit above or below P*, a pro-rata presale and a signer who is not the creator are refused with `StartPriceNotClearingPrice`, `PresaleNotFixedPrice` and `NotCreator`. The first run showed Meteora's own check (a fixed-price presale needs a minimum cap that buys at least one base atom, `ZeroTokenAmount`): the test's caps respect it.
- `cargo test -p cross_settle`: 18 passed (1 is new: `q_price` is P* in Q64.64, floors, and refuses a zero scale).
- Mutation checks: the `q_price` pin removed, the mode check removed, the creator check removed and the floor changed to a ceiling are each applied, the program rebuilt, the suite run and the change reverted (results in `W3D-deploy.md`).

## Not covered

Devnet; the buyer's deposit and claim (Meteora's program, proved on devnet in `DP11-presale-vault.md`); a Token-2022 base with a transfer hook (the `hook` argument and remaining accounts are built and not exercised); a presale for a governed cross (the presale is not a graduation venue and is not gated by the vote); an audit.

## FEATURE_STATUS row wanted

`| B4 Presale Vault fixed-price mode | PARTIAL | `cross_settle::open_fixed_price_presale` opens Meteora's Presale Vault in fixed-price mode at exactly the cross's clearing price, so a tranche for everyone who did not bid carries the price the call discovered; the vault's own sale (deposit, claim, creator withdrawal, unsold refund) was proved on devnet (`DP11-presale-vault.md`); 2 LiteSVM tests against the real binary (`W3D-B4.md`, ADR-0663) | Not deployed (H27, batch 2); no adapters builder, console step or tranche page; a transfer-hook base is not exercised; not audited |`

## What the app layers must add

`packages/adapters`: `buildOpenFixedPricePresale` (the Borsh encoding of the presale's `InitializePresaleArgs`, the presale PDAs `["presale", base, mint, quote]`, `["fixed_price_param", presale]`, `["base_vault", presale]`, `["quote_vault", presale]`, the authority `4Xgt6XKZiowAGNdPWngVAwpYbSwAmbBnRBPtCFXhrypc` and the event authority; the test's `build` is the reference, and the minimum cap must buy at least one base atom). Console: the tranche step after a cross finalizes, with the caps and the times. Diagnose: add `PresaleNotFixedPrice`.
