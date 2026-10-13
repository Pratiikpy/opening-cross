# ADR-0455: Halt state, halt triggers, resume crosses, and the lender price feed

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES W11 (halt-resume triggers) and the halt and "a thin cross never feeds lenders" parts of W8. Builds on ADR-0450 and ADR-0451.

## Context

"Trading always resumes through a cross." A halted asset must not trade at a stale price, and the first price after a halt must be a one-price auction. The triggers named: an issuer pause flag, an oracle circuit breaker (a move above X% in Y slots), a venue-signalled halt, and a corporate action.

## Decision

**`HaltState`** (PDA `["halt", base_mint]`) records whether the asset is halted, why (`IssuerPause`, `VenueHalt`, `CircuitBreaker`, `CorporateAction`), since when, the authority, an optional venue signer and an optional breaker. It is created by the mint authority or the protocol admin.

**Triggers.** All are recorded with a reason.

- Issuer pause: `sync_pause` (anyone) copies a Token-2022 mint's pausable extension into the state.
- Venue or issuer: `set_halt` by the authority or the registered venue signer; `set_corporate_action` by the authority.
- Circuit breaker: `observe_price` (anyone) feeds a fully verified Pyth update for the breaker's feed. Two observations at most `window_slots` apart whose prices differ by more than `move_bps` halt the asset. **An update older than 120 seconds, or not newer than the last accepted one, is refused**: the receiver keeps old updates, and without the bound anyone could replay a stale price to trip the breaker.

**Opting in.** A cross consults the halt state only if its rules name it (`halt_source`, which must be the PDA of its base mint). A halted or corporate-action asset then does not print (`Halted`, `CorporateAction`; a paused mint prints `IssuerPaused`), and the cross refunds everyone. Crosses are permissionless venues; a halt binds those that choose to honour it, which the cross's published rules make visible.

**Resuming.** Nothing but a **printing resume cross** lifts the halt: a cross with `FLAG_RESUMES_HALT` that prints calls `HaltState::resume` (the halt and any corporate-action flag are lifted, the print price and time are recorded, the breaker restarts from the post-resume market). **Only the halt state's authority or its venue signer may create a cross with that flag** (`set_rules` checks the creator against the halt state it is given). The first draft let anyone set the flag, so a wash cross of a stranger's own could have lifted every halt. A series cannot be a resume cross, because its creator is the series address.

**The lender feed.** `PrintFeed` (PDA `["print_feed", base_mint]`) holds the last print that a registered publisher's cross produced with a matched volume of at least the feed's minimum. `clear` updates it only when the cross has `FLAG_FEEDS_LENDERS`, its creator is a publisher, the cross printed and the volume reaches the minimum. A thin cross, a stranger's cross, a cross that did not print and a print on a halted asset cannot move it. A lending market reads one account.

## Not covered

Chainlink or other oracles for the breaker (Pyth only); the breaker has one feed; a lender's own use of the feed; who the venue signer is (HUMAN_TASKS HS2 in the earlier numbering). The pausable extension gives the issuer the power to freeze escrowed base; Q5 discloses third-party powers.

## Evidence

`tests/core/test/rules-guards.test.ts` (halt, corporate action, resume, feed) and `rules-safety.test.ts` (resume authority, breaker trips inside the window and only then, stale and replayed and partly verified and wrong-feed updates, a paused Token-2022 mint). `rules-stocks.test.ts` runs a halted reopen, the authority's resume cross and the next scheduled reopen.
