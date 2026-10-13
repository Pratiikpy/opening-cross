# ADR-0452: A hard-to-game ending: ending buckets, cancel cutoff, a drawn end, and one extension

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES B14, B11, VM3. Builds on ADR-0450.

## Context

A call auction with a hard close invites the last-second order: the bidder who sees the book and shoots at the end, the whale who spikes the indicative price and withdraws, the bot that races the clock. The specification asks for a VRF random end, a delayed and coarse indicative price in the final window, a cancel cutoff before that window, explicit tie-breakers (done, ADR-0003) and a re-sign rule for large price moves (ADR-0451).

## Decision

**The ending period.** A cross may declare `ending_secs`: the last stretch before `close_ts`, cut into 2 to 8 equal buckets. An order placed before the period belongs to no bucket; one placed in it belongs to the bucket of the instant it landed. Orders in bucket `b` write to a shard of their own (index `32 + b`), apart from the main shards, so they can be counted or left out as a unit. This is a candle auction: after the call, a draw picks the last counted bucket `e`, uniformly over the buckets. Buckets after `e` are never merged into the book (`merge_shard` refuses them) and their orders are refunded in full at claim, exactly as unrevealed sealed orders are. A bidder who waits for the last moment gains the chance that the draw excludes them; a bidder who bids early loses nothing.

**The cancel cutoff.** Orders can be cancelled until `close_ts − ending_secs − cancel_cutoff_secs` and not afterwards, so a bidder cannot place a decoy and withdraw it once the final window opens. An order that cannot be cancelled is still refunded in full if the cross does not print or the draw excludes its bucket. The cutoff takes away optionality, never funds.

**The draw** is two permissionless steps so that nobody can choose the moment: `draw_begin` records the slot once the call and any reveal window are over; `draw_finish`, at least 20 slots later, hashes the `SlotHashes` entries of the first recorded slots at or after `begin + 4`, `+ 8`, `+ 12` and `+ 16`. A leader produces four consecutive slots, so the four samples fall in four different leaders' turns: no single block producer controls the result, and moving it takes the cooperation of all four, each skipping a block. Each sample must be within 32 slots of its target and the sysvar must still reach back to it (it keeps 512 slots), or the draw is void and anyone restarts it. The seed is `sha256("opening-cross/draw/v1" ‖ cross ‖ epoch ‖ purpose ‖ h1 ‖ h2 ‖ h3 ‖ h4)`, stored in the cross and emitted with the sampled slots, so anyone can check the arithmetic.

**The honest limit: this is randomness the cluster attests, not a verifiable random function.** Its security rests on the cost of four leaders skipping blocks at once. The specification calls for a VRF; a VRF program is not on devnet and costs money, so it is not used, and the draw state separates begin, seed and apply so a VRF seed can replace `draw_finish` later without touching the rest. NOT VERIFIED on a real cluster's slot hashes beyond the LiteSVM tests that set them; the devnet proof (`scripts/deploy-batch-2.sh`) records what the cluster produced.

**The extension.** A cross with an `extension` rule that fails to print for any reason (ADR-0451) opens its call again once, for a length drawn uniformly between the published bounds (a second draw with its own purpose). Orders of the extension write to extension shards (`40 + j`), are merged on top of the existing book, and cannot be cancelled. The clear after the extension is final.

**Coarse display.** The indicative price and the imbalance are shown to bidders only in coarse buckets in the final window. For a **sealed** cross nothing is shown on chain at all. For an open cross the book is public by construction, so this is a rule for the interfaces we ship: `coarseIndicative` (in `@opening-cross/cross-core-client`) gives the nearest band of the grid and a three-way imbalance for the API and the apps to show. **Wiring it into the apps and the API belongs to their owners** (listed in the evidence file). Anyone reading the accounts directly sees the true book, and the documentation says so. A cross that needs the information hidden uses the sealed disclosure mode.

## Evidence

`tests/core/test/rules-ending.test.ts` (8 tests): orders land in the bucket of the moment; cancels close before the period and stay closed; the clear needs the draw; a draw cannot finish early; the drawn end decides which buckets merge, price, and refund, and each order's balance is checked on chain; a draw whose hashes left the sysvar is void and restarts; an extension runs once with a drawn length inside the range, a second failure is final, and an extension nobody draws clears after the grace period. Rust unit tests: bucket placement is monotone, aux shard bits are distinct.

## Not covered

Grinding by an adversary who controls four consecutive leaders at the right time (the assumption above); a VRF source; interfaces other than ours that show the book; the exact "±20% re-sign" confirmation round (ADR-0451 explains the on-chain reading).
