# ADR-0602: What a bidder sees of a cross's rules, and what the order ticket refuses before signing

Status: accepted (2026-10-14). Builds on ADR-0450 to ADR-0460, ADR-0504 and ADR-0600.

## Decision

- The cross page gains a Rules tab built from `GET /v1/crosses/:address/rules`: every rule in the words of what the program enforces, the state of the draw, and, for a connected wallet, which allocation classes it can take now and why not. A cross without rules says so, and says whether that is because the network runs the first release (ADR-0600).
- The order ticket checks, before the wallet is asked, the same things the program refuses (`admit` in orders.rs, `on_commit` in identity.rs): a class-1 order over the small-buyer cap or not exactly one lot, a lockup outside the class-2 range, class 3 after the early window without a priority pass, a class for a declared insider, the per-wallet order and escrow limits from the wallet's live orders. A blocked order disables the button and says why with the figures. Cancellation that has closed (or an order in the extension) must be acknowledged with the time stated.
- A cross with rules places orders through `/v1/tx/place-order-ext`. An order in an ending period names the shard of its window; if that window ends within twelve seconds the build waits for the next window and is made again, and a "wrong shard" refusal is explained and costs nothing. Sponsored orders are off for crosses with rules: the sponsor route builds without the rules tail.
- In the ending period the hero shows `/indicative` (the nearest of eight bands, a direction) instead of the book, and the Book, Orders and Replay tabs and the order preview hold the exact figures back until the call closes. This is the display rule of ADR-0504, said as such on the page: the accounts are public.
- After the call, anyone can begin or finish a draw the rules owe (the settle panel offers it instead of a settle that would be refused).

## Not covered

The wallet's priority-gate pass is read from `/v1/gates/:mint?wallet=`; if that read fails the class is not blocked and the program decides. The applicant record is not served by the API; usage is derived from the wallet's live orders in the cross, which is what the record counts while the cross is live.
