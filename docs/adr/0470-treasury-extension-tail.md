# ADR-0470: the treasury extension is a tail on the existing account, added by new instructions

Status: accepted (2026-10-13) · Builds on ADR-0014 · Covers E1/E2, E3/VM8, E4/A6, E5, E6, E7, E8, V3/Y6 (the individual rules are ADR-0471 to ADR-0475)

## Context

The first release of the `treasury` program is deployed on devnet (`HoRbUkEX…`, 274,184 bytes, sha256 `ce6b2b61…`). Its `Treasury` account is a fixed-size Borsh account of `8 + Treasury::INIT_SPACE` = 237 bytes. Every feature in this batch needs state the account does not have: governance parameters, a NAV window, a distribution accumulator, revenue rounds, a disclosure clock, an assignment flag, a wind-down window. Existing accounts must keep deserializing, every existing instruction must keep its account list and meaning, and the new behaviour must not be bypassable by calling an old instruction.

## Options

1. Reshape `Treasury` (add fields to the Borsh struct). Old accounts no longer decode; a migration instruction would have to run on every account before anything else works.
2. Put the new state in a separate PDA (`["ext", treasury]`) and make the new instructions read it. The old instructions (`spend`, `trigger_liquidation`, `redeem`) have fixed account lists and cannot see the PDA, so a rule such as "no team spending while NAV mode is on" could be bypassed by calling `spend` as before.
3. Append an extension **tail** to the same account, after the old fixed-size prefix. Anchor decodes the Borsh prefix and ignores trailing bytes, and on exit it re-serialises only the prefix, so the tail is never touched by old code paths. Old instructions read the tail from the account they already receive.

## Decision

Option 3.

- The tail starts at byte 237 and begins with the magic `TEX1` (`Ext` in `programs/treasury/src/ext.rs`; the decoder in `packages/treasury-client/src/ext.ts` is checked against the program by a test that compares the account length to the decoder's fixed size). A treasury whose account ends at byte 237, or whose tail lacks the magic, is un-extended and behaves exactly as the first release.
- `init_ext` (authority only, once, treasury Active) grows the account by the tail (`realloc`, rent paid by the authority, zero-filled), creates the coin vault (`["coins", treasury]`) and the distribution vault (`["dist", treasury]`), validates the parameters and writes the tail. Every parameter is fixed afterwards; there is no setter.
- `spend`, `trigger_liquidation` and `redeem` keep their accounts. If the tail exists they additionally: apply `Ext::guard_team_outflow` (no NAV mode, assignment recorded when required, no overdue holder disclosure request); subtract unvested grant coins from the liquidation snapshot and stamp the wind-down start; refuse after the sweep. Without a tail they are the old logic.
- All other behaviour is new instructions. Events and accounts are new; no existing event, account or instruction changes. New PDAs: `proposal`, `vote`, `stake`, `round`, `grant`.
- The extension parameters are chosen by the team and are public in the tail. The program refuses parameters that would be a back door: quorum below 10%, a majority threshold at or below 50% or at 100%, a vote shorter than three days, a timelock shorter than one day, a withdraw-only window shorter than 180 days, a revenue clock that starts in the past, a distribution stream between 1 second and 1 hour (0 means paid at once).

## Evidence

`tests/core/test/treasury-ext.test.ts` (7 tests) runs the **deployed** v1 binary (`tests/fixtures/treasury_v1_devnet.so`, checked against sha256 `ce6b2b61…`), creates and operates a treasury with it, swaps in the new binary at the same program id in LiteSVM, and continues: spend, lapse, liquidation and redemption work on the old account, the new instructions refuse it with `NotExtended`, `init_ext` extends it in place and leaves every old field equal, and `trigger_liquidation` then stamps the wind-down start. A treasury the old binary had already put into liquidation redeems under the new binary. `treasury.test.ts` (the 4 original tests) passes unchanged.

## Consequences

- Deploying the upgrade breaks nothing that exists: no account is migrated, no instruction changes shape, and the generated client only gains instructions, accounts, events and errors. The program grows from 274,184 to about 769,016 bytes, so the devnet program account must be extended first (see the batch-2 funding row in `docs/HUMAN_TASKS.md`).
- `Ext` has no spare bytes. A later release adds fields by a second tail version (a new magic) or by new PDAs, never by reordering this struct.
- Not an audit. The tail design is proved on LiteSVM only; devnet proof is pending the upgrade.
