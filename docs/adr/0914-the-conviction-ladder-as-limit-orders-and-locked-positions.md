# ADR-0914: The conviction ladder as limit orders, and as a locked position (D5, D2)

Status: accepted (2026-10-16) · Builds on ADR-0023, ADR-0487

## Context

D5 asks for a DLMM conviction pool with "time-bound lock tiers" and "limit orders in a separate DLMM pool". ADR-0023 built the ladder as a position and recorded the gap "limit-order variant not built". It also claimed the issuer "cannot pull it back without Meteora's own position instructions", which is true of everyone and says nothing about the issuer. Running the real binary showed that none of the three forms below locks anything unless it is made the one way DLMM enforces a lock.

## Decision

Three forms of the same idea, each through Meteora's own instructions, with what each commits the issuer to stated plainly:

1. **A position** (`buildDlmmConvictionLadder`, ADR-0023). Liquidity in bins above P*. It earns the pair's fee. The owner can withdraw it at any time, so it is depth, not a commitment.
2. **Limit orders** (`packages/adapters/src/limitladder.ts`: `planLimitLadder`, `buildPlaceLimitLadder`, `buildCancelLimitLadder`, `buildCloseLimitLadder`). Ask orders owned by the issuer's wallet, one order account carrying up to 70 rungs. A rung sells a fixed amount at one bin's price and earns no trading fee. It reuses the greenshoe's pieces (ADR-0487: bin arrays, the memo program, the pair's accounts, the cross_gate hook accounts) with the owner a wallet instead of a program. The greenshoe is the bid-side, program-owned counterpart; this is the ask side and is revocable.
3. **A locked position** (`buildDlmmConvictionLadder` with `lockUntil`). The position is made with `initialize_position_by_operator`, whose `lock_release_point` DLMM enforces on every withdrawal, the owner's included. This is the commitment. A tier is one such position with its own release time; several positions make several tiers.

The API places ladders (`ladder-limit-place`, `ladder-position-place` with `lockUntil`), cancels and closes them, and reads a position (`GET /v1/crosses/:address/ladder`, including `locked` and `lockedUntil`).

## Facts found by running the real binary

- **Limit orders are revocable.** A rung cannot be cancelled in the second it was placed, unless a buyer has filled it completely (`LiquidityLocked`); one second later the owner cancels it. The lock counts seconds: a hundred thousand slots at one timestamp release nothing, one second does. It guards against placing and cancelling in the same instant; it is not a commitment.
- A buyer crossing three of six rungs paid the rungs' bin prices (average 1.20298 against rungs at 1.2007 to 1.2067); cancelling returned the base that did not fill and paid the quote the fills earned: 1,669,969,473 base back and 1,330,030,527 bought add to the 3,000,000,000 laid, exactly. The first, fully filled rung paid 600,654,286 for 500,000,000 base at a bin value of 600,352,305: the bin price plus a share of the pair's 0.1% fee, less than the whole of it.
- DLMM allows an ask in the active bin, refuses one below it (`InvalidPlaceLimitOrderParameters`), a zero amount (the same) and a stale view of the active bin (`ExceededBinSlippageTolerance`). The builder keeps the ladder strictly above the active bin by default, so that nothing sells below P*. `close_limit_order_if_empty` succeeds and does nothing while a rung holds anything. Only the owner cancels (`InvalidLimitOrderOwner`).
- **The lock is real.** A locked ladder (20 bins, 2,000,000,000 base, 30 days) could not be withdrawn after 1 day, 7 days or 30 days less a second (`LiquidityLocked` each time), and was withdrawn at the release time, the base returning to the wallet. The position's address is a PDA of the key that signed, the lower bin and the width; the account carries the release time.
- **The lock can be made only while the pair is closed** (a batch-opened pair, ADR-0483): once the pair has opened the same instruction is refused for everyone (`UnauthorizedAccess`). While it is closed any wallet may lock a ladder of its own; the lock constrains only its maker's tokens. So the order of events for a committed ladder is: open the pair in a batch window, lay the locked ladder before the start, let the pair open.

## Not covered

Lock tiers as a single instruction (a tier is a separate position), moving a locked ladder (it cannot be rebalanced before its release, and the API says so), a limit order on a hooked base through `place_limit_order` (the accounts are built and not exercised), the `Operator`-account path for locking after the pair has opened, and any run on a cluster (H27). NOT VERIFIED: that a ladder, locked or not, improves a launch's price behaviour; no backtest or live comparison was run.
