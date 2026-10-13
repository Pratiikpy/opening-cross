# ADR-0454: Lockups, vesting, and issuer neutrality (declared insiders, a bond, a challenge)

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES B12 (buyer lockups, mandatory insider lockups) and VM7. Builds on ADR-0450 and ADR-0453.

## Context

Anti-flip wants optional buyer lockups and mandatory insider lockups; issuer neutrality wants insider bids kept out of the minimum raise, locked, and backed by a bond. ADR-0005 and the hooks in ADR-0004 rule out holding fills under a Token-2022 transfer hook, and `mint_to` at claim must not be replaced by a later mint (a cross revokes mint authority at `finalize`).

## Decision

**Locks.** A fill that is locked goes at claim to the cross's **lock vault** (a token account owned by the cross PDA, created by `init_lock_vault` once the base mint exists) instead of the owner's wallet. In a mint-mode cross the tokens are minted straight into the vault (no hook runs on `mint_to`); in an escrow cross they move from the base vault. A `Lockup` record (PDA of cross, owner, order nonce) holds the amount, the start (the clear time), the cliff and the vesting length. `release_locked`, callable by anyone, pays the **vested, unreleased** part to the owner: nothing before the cliff, everything at the cliff when there is no vesting, a straight line after it. The record closes when empty. The lock changes when a holder can sell and never what they paid or how much they got.

- The record's rent comes from the order account being claimed, so locking costs the cranker nothing. (The first draft credited lamports to the lockup account before allocating it. The runtime refuses that: the CPI sees lamports appear on one account with no debit. `open_lockup` now allocates, assigns, then moves the rent; `rules-classes` and `rules-insiders` cover it.)
- Locks need a base mint that exists and is not under a transfer hook for the release (a hooked transfer needs forwarded accounts): `set_rules` refuses lock rules on deferred-mint crosses. Releasing a hooked mint's lockup is NOT VERIFIED.
- A claim passes the lock accounts only when it locks something. A refund (a cross that did not print, an order that was not filled) needs none, so a client that knows nothing of rules can always collect one.

**Who is locked.** A buyer who chooses class 2 (≥ `min_lock_secs`), a class-1 buyer when the issuer requires vesting, and every declared insider (`neutrality.insider_cliff_secs`, `insider_vest_secs`). Locks are capped at four years.

**Insiders.** The issuer names up to eight insiders in the rules. Their buys are tallied apart in the class book, flagged on the order, locked, and **left out of the counted volume** that the minimum volume, the minimum raise and the float are checked against. The program uses an upper bound on what insiders were allocated (`class0_fill_upper_bound`), because per-order fills round down: the counted volume can only be under-stated, so a declared insider can never help a cross meet its minimum.

**The bond.** `neutrality.bond_quote` is posted from the creator into the cross's quote vault when the rules are set. For `challenge_secs` after the clear anyone may allege that another wallet was an undeclared insider (`challenge_insider`: a deposit of 0.01 SOL and the hash of off-chain evidence). The **arbiter**, a key the protocol admin names (`set_arbiter`), rules: if the challenge is upheld it slashes part of the bond (half to the challenger, half to the protocol's fee recipient) and the deposit returns; if rejected the deposit goes to the protocol. `finalize` waits until the window has passed and no challenge is open, then returns the surviving bond with the proceeds.

- **An absent arbiter cannot hold the proceeds back for good.** A challenge nobody rules on within 14 days is closed by anyone (`expire_challenge`): the deposit returns and the bond is untouched. Without this, one 0.01 SOL challenge could block `finalize` indefinitely.
- The evidence is off chain. The arbiter is a trusted role, and who it is belongs to the founder (docs/HUMAN_TASKS.md, H28). What is on chain is the bond, the window, who may rule and the split.
- What this does not do: detect a funding link (it is a judgement), unwind the fill of a wallet found to be an undeclared insider (the slash is the remedy), or keep insiders from selling after their lock.

## Evidence

`tests/core/test/rules-insiders.test.ts`: declared insiders do not count toward the raise; their fills are locked; finalize waits out the window; an upheld challenge slashes and splits; one after the window is refused. `rules-safety.test.ts`: an unanswered challenge expires after 14 days and finalize proceeds; a refund needs no lock accounts; a locked claim without the lock accounts is refused; unit and property tests for vesting (never above the amount, never decreasing).
