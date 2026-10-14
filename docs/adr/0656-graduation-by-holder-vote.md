# ADR-0656: Graduation by holder vote is a rule plus a program, `cross_graduate` (D10, Z0)

Status: accepted (2026-10-14) · Supersedes the "design recorded, not built" outcome of ADR-0486 for D10 and Z0

## Context

PRODUCT_FEATURES [D10, Z0]: "Graduation by holder vote, gated on retention and organic volume, never market cap." ADR-0486 recorded two obstacles: DBC migration is permissionless once the curve completes, so a vote cannot gate it; and a vote can only gate a creator-initiated graduation such as `seed_damm_v2`, which needs a vote-escrow account family and a retention and organic-volume signal the program cannot compute. The existing treasury vote (ADR-0471) decides spending above an allowance, not the venue of a graduation, and it cannot bind the adapters, because the adapters take their authority from the cross's creator.

## Decision

Graduation is governed by a **rule the creator sets before the first order** and a **vote** the program runs. Three pieces, none of which breaks a deployed account:

1. **The rule.** `cross_core` accepts a new rule flag, `FLAG_GOVERNED_GRADUATION` (`1 << 5`), in `set_rules` (one line in the settable mask; flags are `u16`, no layout change, no migration). Rules are written once, only by the creator, only in the slot the cross was created, only before any order (ADR-0450), so the creator cannot add the requirement later and cannot remove it afterwards. A cross without the flag, and every cross that exists today, behaves exactly as before.
2. **The gate.** `cross_settle`'s seeding instructions (`seed_damm_v2`, `seed_damm_v2_batched`, `open_dlmm_pair`, `open_dlmm_pair_batched`, `open_dlmm_pair_badged`, `seed_raydium_cpmm`) read that flag from the cross. For an ungoverned cross nothing changes: no extra account, no extra check beyond reading the flag. For a governed cross the **last remaining account** must be the `Outcome` PDA of `cross_graduate` (`["outcome", cross]`), owned by that program, for this cross, naming this venue; otherwise the new error `GraduationNotApproved` stops the call before any CPI. (`open_dlmm_pair_badged` takes its two badge accounts first, then the outcome.) The settlement adapter still checks P*, the creator and everything else it checked.
3. **The vote.** `cross_graduate`:
   - `init_charter` (creator, before the first order, on a cross that carries the flag) fixes the terms for good: a quorum of 10% to 100% of the token's live supply, a voting window of 3 to 30 days, an optional minimum organic volume and the key allowed to attest it.
   - `start_round` (creator, once the cross is finalized and its token exists) opens a round; at most three rounds, one at a time.
   - `cast_vote(venue, amount)` locks tokens in the round's escrow behind DAMM v2, DLMM or Raydium CPMM until the window ends. **Retention** is therefore what the vote measures: only tokens still held can vote, and a token that voted cannot be sold until the window closes. A voter can add to its stake but not change venue.
   - `post_volume` (the charter's attester) states the organic volume in quote atoms. The program cannot measure it; the charter says who does.
   - `finalize_round` (anyone, after the window) passes a round when locked tokens reach the quorum of the live supply, the winning venue holds a strict majority of what was locked (a tie has no winner) and, if the charter asks, the attested volume reaches the minimum. `publish_outcome` writes the outcome that `cross_settle` reads. `withdraw_vote` returns the stake after the window.
   - **Never market cap:** no price or valuation enters any condition.

## What this does and does not enforce

- Enforced on chain: the creator of a governed cross cannot open a pool on any venue the holders did not choose, and cannot open one at all without a passed vote. A failed vote leaves the market without graduation: that is the holders' veto, by design, up to three attempts.
- Nothing stops anyone from creating a pool on any venue by hand with their own tokens. That pool is not the cross's graduation: it has no P* guarantee and the product shows a cross as graduated only through the adapters, so the vote governs the venue of record, not the existence of other markets.
- The creator still supplies the liquidity and runs the seeding transaction; the vote chooses the venue, not the amount, and does not force the creator to graduate.
- Organic volume is an attested figure. A charter with an attester is as honest as the attester; a charter without one has no volume gate.
- Quorum is measured against the live supply when the round is finalized. An issuer that still holds a mint authority can raise the supply while a round is open and with it the quorum, which is a veto by dilution; mint-mode crosses revoke the authority at `finalize`, so this applies to escrow-mode crosses whose token was minted elsewhere, and the issuer console should show whether the mint authority is gone before holders are asked to vote. (The test mints the creator's liquidity after the vote for that reason.)
- DBC-launched markets still migrate permissionlessly, as ADR-0486 said: the vote governs auction-cleared markets and their adapters, not a DBC curve's own graduation.

## Consequences

- `cross_core` gains one constant and one bit in a mask. Its size changes by 8 bytes (1,191,504 to 1,191,512) and its upgrade is part of batch 2.
- `cross_settle` grows (723,992 to 732,488 bytes) and gets one new error (`GraduationNotApproved`, code 6029, appended). Existing clients keep working for every ungoverned cross.
- New program `47f6BhDPCxmW9C9DuuMS2VnbCoU4wnSvjReEwy9Zdke7`, client `@opening-cross/cross-graduate-client`, 7 instructions, 7 events, 19 errors.
- The SDK and the issuer console add: the flag in the rules step and in `rules-check.ts` (the settable mask), the charter step, the vote page, and the extra last account on the seeding builders of a governed cross.
