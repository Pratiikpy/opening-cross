# W3D-L1: stake-bonded listing (`cross_listing`), proved on LiteSVM

Status 2026-10-14: **program, client and tests built; proved on LiteSVM against the real `cross_core`; not deployed (H27).** Not audited. ADR-0653. Row L1.

## What was built

A new program `6VsT7X4G7qjRaredx4Y9q6asGkySiXGVpNr4RrdbxSSi` (322,720 bytes), 7 instructions (`create_venue`, `open_bond`, `deposit_bond`, `withdraw_bond`, `list_cross`, `release_listing`, `slash_listing`), 6 events, 15 errors, and the client `@opening-cross/cross-listing-client`.

A venue fixes its terms for good (bond token, `min_bond`, a release delay of at least a day, the slash recipient). A lister opens a bond, deposits, and lists a cross it created that is still taking orders; each listing sets aside `min_bond`. When the cross ends well the bond is released after the delay; when it ends because its settlement adapter never bound a mint (`NoPrintReason::SettlementExpired`, written only by `cross_core`) anyone can slash the set-aside bond to the venue's slash account.

## Tests

- `tests/core/test/listing.test.ts`: **8 passed**. A lister deposits 250, lists (100 set aside), can withdraw 150 and not one atom more, a stranger cannot withdraw it; a listing without enough free bond (`BondTooSmall`), a second listing of one cross, a cross that is no longer live (`CrossNotLive`) and **a cross the lister did not create** (`NotTheCreator`, and borrowing another lister's bond account) are refused; a cross that clears, is claimed and finalized releases the bond after the delay and not before, then a release or slash of it is refused; a cross that did not print for a market reason (`NoCross`) is not a fault (slash refused) and releases the bond; **an unbound settlement** slashes exactly 100 to the venue account, the buyer is refunded in full by the cross, the bond is down 100 and the vault matches, a release of it is refused, a second slash is refused; the slash destination cannot be the caller's account and a listing cannot be settled against another faulted cross; venue terms with no bond or a delay under a day are refused.
- `cargo test -p cross_listing`: 1 passed.
- Mutation checks: slash with no fault test -> 3 tests fail; release without the delay -> 1 fails; withdraw ignoring the set-aside bond -> 1 fails; slash destination not bound to the venue -> 1 fails; creator check removed -> 1 fails (this one survived until the "only the creator can list" test was added, then was caught).
- `cargo fmt --check`, `cargo clippy -D warnings`: clean.

## Compute units (LiteSVM)

open_bond 38,894 · list_cross 18,580 · slash_listing 19,985 · deposit_bond 15,327 · withdraw_bond 13,871 · create_venue 12,854 · release_listing 7,934.

## Size and deploy cost

322,720 bytes; program account rent 1.640 SOL (permanent) and a returned buffer.

## Not covered

Devnet; a Token-2022 bond with a transfer hook; faults other than an unbound settlement (none is provable from the cross account alone, ADR-0653 says which are not); a venue UI; an audit.

## FEATURE_STATUS row wanted

`| L1 stake-bonded listing | PARTIAL | A `cross_listing` program: a venue with fixed terms, a lister's bond, listing of a cross the lister created, release after the delay and a slash to the venue's account when the cross ended because its settlement never happened; 8 LiteSVM tests against the real `cross_core` (`W3D-L1.md`, ADR-0653) | Not deployed (H27); no SDK builders, API route, indexer projection, venue page or wizard step; the only slashable fault is an unbound settlement; not audited |`

## What the app layers must add

SDK: builders for the seven instructions (generated PDAs: venue, bond, listing). Indexer: project the 6 events and the `Venue`, `Bond`, `Listing` accounts. API: venue and listing reads, the bond state of a lister, unsigned-transaction routes. Keeper: call `release_listing` and `slash_listing` for every listing whose cross has ended (both are permissionless). Wizard: a "list on this venue" step showing the bond that will be set aside. Diagnose: add the 15 errors.
