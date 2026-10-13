# W2C-S7: conviction reputation (needs a program)

Outcome: **needs-program**. The row says the reputation is "earned only by holding through lockups". Holding through a period cannot be proven from a balance read: a wallet that held on day 1 and day 90 may have sold on day 40 and bought back. The only on-chain proof is a lock the holder enters, which `cross_core` and `cross_gate` do not offer to a holder (`cross_gate::set_lock` is an issuer rule over transfers, and only an issuer can tighten it).

An off-chain score computed from balances would be a number someone could game by timing, labelled as something it is not. It is not built.

## The change, for the programs agent

A new program `conviction`:

- `lock(holder, mint, amount, unlock_ts)`: moves `amount` of `mint` into a PDA vault `["lock", holder, mint, nonce]` and records `unlock_ts`. Nothing can move it before `unlock_ts` (there is no early exit, which is what makes it conviction); after it, `unlock(holder)` returns it.
- `mint_badge(holder, lock)`: after `unlock_ts` and only once per lock, mints one Token-2022 token with the `NonTransferable` extension (soulbound) and `MetadataPointer` to a per-holder badge mint, with amount equal to `amount * (unlock_ts - locked_at) / 86_400`, so the badge measures token-days held locked, not a flag.
- The badge is the credential: `cross_gate` can read it as one more pass rule ("holds at least N token-days of conviction in this issuer's coin"), which is the use the specification gives (priority, never a loyalty farm: the specification's "Not doing" list rules out points and tiers).
- Events for the indexer.

Tests that must exist: the vault cannot be drained before `unlock_ts` by anyone including the program authority; a second `mint_badge` for one lock fails; the badge cannot be transferred or burned by anyone but the holder; the arithmetic rounds down and cannot overflow.

Web and mobile follow: a "Lock to earn conviction" action on a holding and the badge on the portfolio. Not built before the program exists, because there would be nothing to show.
