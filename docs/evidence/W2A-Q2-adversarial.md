# W2A-Q2: Mollusk tests, and an adversarial search against the clearing rule

Date: 2026-10-13. Row Q2 ("No Mollusk or Surfpool tests written; no adversarial simulator").

## Mollusk: instruction-level tests that run on Windows

`tests/mollusk` is a crate of its own (own `[workspace]`), because `mollusk-svm 0.16.2` needs a compiler newer than the repository pin (1.96.1). The blocker found earlier was a missing toolchain, not Windows: on Windows MSVC with `rustc 1.101.0-nightly (e9bbadf68 2026-10-12)` (`rustup toolchain install nightly --profile minimal`) it builds in about a minute and runs. `cargo +nightly test`, from `tests/mollusk`, against the real `target/deploy/cross_core.so`:

**11 passed, 0 failed.** They pin, one instruction at a time with hand-built accounts: the Anchor discriminators derived and compared with the IDL; `init_protocol` writing exactly the given fields into a 147-byte account the admin pays rent for (7,110 compute units); the 100 bps fee cap on each of the four slots (accepted at 100, refused at 101 with `FeeTooHigh` 6004); no second init (and the failed second init leaves the account byte-identical); `init_protocol` without the admin signing; `set_paused` by guardian and by admin and by no one else (a stranger gets `Unauthorized` 6001; a listed guardian who did not sign gets `AccountNotSigner` 3010; 4,297 compute units); the protocol PDA seed constraint (`ConstraintSeeds` 2006); `set_guardian` and `set_protocol_fees` the admin's alone, and `set_protocol_fees` changing nothing but the fees; the two-step admin handover (proposing changes nothing, a stranger and the old admin cannot accept, the successor can, and the old admin then loses its power); an unknown instruction answered with Anchor error 101 after 1,343 compute units.

Not covered: the order, clearing and settlement instructions, and the other four programs. They need token accounts and the cross state machine and are covered end to end by `tests/core`.

## Surfpool

Not done. Surfpool 1.6.1 runs in WSL (`Q2-fuzz.md`), but no test needs what it adds over the local validator and Mollusk already used here; its mainnet-forking and time-travel features would matter for testing against live Meteora state (for example reproducing a DBC slippage failure for the diagnosis package), which was not attempted. No Surfpool test exists.

## An adversarial search

`tools/simulator/opening_cross_sim/adversary.py`. A strategic participant gets a payoff and a grid of strategies; everyone else is a fixed random population; the plain-Python rule (held equal to the compiled rule by the differential tests, see `W2A-V-E-clearing-wasm.md`) decides each outcome. A gain found is a lower bound on what an adversary can do; "none found" is not a proof there is none.

**Demand reduction (a large buyer).** A hand-checkable book: sellers offer 50 at 100 and 50 at 150, a small buyer wants 40 at up to 200, and the strategic buyer values 50 units at 200 and 50 more at 190. Bidding its values clears at 190 and the buyer is rationed to 60 units for a surplus of 500. Dropping the second block clears at 150 for 2,500. The search found better: bidding 160 and 150 for the two blocks still clears at 150 and keeps 10 more units, 2,900, almost six times the honest surplus (a test pins this book). Over 400 random books (40 buyers, 12 sellers, a four-block buyer), the best deviation beat honest bidding in 60.5% of books, never lost to it (honest bidding is one of the strategies searched), by a median of 11% of the honest surplus and 75% at the 90th percentile. **Truthful bidding is therefore not a best response for a buyer with several units to buy**, which is the known property of uniform-price auctions. For a single one-unit order in a deep market the search found no gain (also pinned by a test, which is an example and not a proof). ADR-0003 and OCIP-1 §7.3 said incentive compatibility was NOT VERIFIED; they now say it is refuted for multi-unit buyers.

**Shilling (an issuer lifting its own price).** The issuer sells at a reserve and adds a buy order from a wallet it controls, on a grid of limits and sizes. Net of the shill's cost and a 30 bps fee, it helped the issuer in 1.25% of 400 books, by a median of 0.9%. With these populations shilling is rarely worth it.

**Sniping (an uninformed late order at the top of the grid).** It improved the buyer's surplus in 4.5% of books and lowered it in 67.8%: an order that pays the one clearing price gains little from a high limit, and a high limit risks paying a price above its value.

## Not covered

The populations are assumed (log-normal values around a known true value), not observed; no live crosses of this shape exist to calibrate against. Only buyer-side and issuer-side manipulations were searched: not coordinated groups, not cancelling and replacing orders over time (the sealed call hides the book until the reveal, so these are weaker there), not strategies using information about other bidders. The search grid is coarse (shading in 2.5% steps, dropping whole blocks). Whether to restrict large bidders, split orders, or accept the property is a product decision (HUMAN_TASKS), not made here.
