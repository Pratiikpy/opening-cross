# ADR-0459: Several oracles with a median, a band that widens off hours, and a guard for a changed multiplier

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES C1, VM9, C3 (listing cross with a multi-oracle median and a band that widens off hours) and the scaled-UI-multiplier part of C5. Builds on ADR-0005 and ADR-0451.

## Context

One Pyth feed anchors a reopen today. A single feed is one point of failure and, for a stock, is least reliable exactly when a reopen matters (after a weekend or off hours). Tokenized stocks also change their economic meaning through corporate actions: a Token-2022 mint with a scaled-UI-amount extension changes its multiplier at a stated time (a split, a dividend).

## Decision

**Oracle set.** The cross's own `OracleGuard` names the first Pyth feed. `oracle_set` names up to two more (`extra_feeds`). At the clear:

- each price is usable only if its account is owned by a Pyth receiver, parses, carries the feed it is supposed to, is fully verified, is no older than the guard's staleness bound and converts to the cross's units;
- the guard needs `quorum` usable prices (otherwise `OracleUnavailable`), and if `max_spread_bps` is set the usable prices may not differ from one another by more than that share of the lowest (otherwise `OracleDisagreement`);
- the reference is the median of the usable prices (the middle of three, the mean of two, rounded down, the one price of one), so one wild oracle does not decide;
- the divergence bound is the guard's `max_divergence_bps`, widened by `off_hours_widen_bps` while no session of the cross's calendar is open.

A single feed with no set behaves exactly as before. The extra feeds are extra accounts at the clear (remaining accounts, in the order of `extra_feeds`), and the calendar account when the band widens; leaving one out is an error and never a skipped check. A cross on a calendar may name only feeds that calendar approves (`FeedNotApproved`), as the first already had to.

**Scaled-UI multiplier (C5).** With `FLAG_GUARD_SCALED_UI` the rules record the base mint's effective multiplier (the bits of the `f64`, compared for equality, never used in arithmetic). If the effective multiplier at the clear differs, the cross does not print (`CorporateAction`) and every order is refunded: the grid was drawn for the old multiplier. A change scheduled for after the clear does not void it. A mint without the extension is refused.

## Not covered

Chainlink, Switchboard or any non-Pyth oracle (the receiver is the only verified source parsed). The unverified items: a real Pyth equity feed on devnet needs the entitlement in H11 and was not exercised; the oracle tests use hand-built `PriceUpdateV2` accounts in the receiver's layout. Pegging the grid to a changed multiplier (rather than refusing to print) is not done.

## Evidence

`tests/core/test/rules-oracle.test.ts` (11 tests): the median ignores an outlier; the median moves the verdict; the quorum with a stale, partly verified or wrong-feed oracle (five combinations); disagreement; a missing extra account; inconsistent sets; the wider band prints off hours and refuses on hours; a calendar must approve the extra feeds; the multiplier unchanged, changed before the clear, changed after, and a mint without the extension. Rust unit test for the median.
