# ADR-0950: The organic-volume interval gets a guard, Jito bundle evidence, and an attester that states only its lower bound

Date: 2026-10-16 · Status: accepted · Implements PRODUCT_FEATURES [F2]; builds on ADR-0302 (integrity analysis) and ADR-0656 (governed graduation, whose charter takes an attested organic volume)

## Context
F2 was a version-0 interval (lower and upper bound of organic volume) that gated nothing, saw no Jito data, and had been validated only against synthetic wash injection. A measure that gates nothing is a dashboard; a graduation charter that asks for "an attested organic volume" needs someone to attest it, and an attester that signs whatever it computes would turn an experimental interval into a binding claim.

Two facts about Jito bundles, measured on mainnet on 2026-10-15 (`packages/integrity/scripts/jito-live.ts`), decided the design:
- Bundles with more than one signer are ordinary traffic: 22 of 40 multi-transaction bundles sampled had one. A relay sponsoring a user's fees appears as the bundle's "tipper" while the user's wallet pays the lamports (3 of 40). So "two bidders in one bundle" is not, by itself, evidence of common control.
- The public bundle explorer keeps about seven days (the oldest bundle it returned was seven days old). Absence of a record after that says nothing.

## Decision
1. **Evidence.** `jito.ts` derives the eight tip accounts from Jito's tip-payment program (never typed; checked against the block engine's `getTipAccounts` and against each account's owner on chain), finds the transaction that created each order account, and asks the explorer which bundle it landed in. Two bidders are linked, and join a funding cluster, only when their orders share a transaction (both signed it) or share a bundle one of the two paid for (the payer is read from the tip transfers in the bundle's transactions, not only from the explorer's `tippers`). Bidders in a bundle paid for by a third party are reported as `weakLinks` and never merged. A transaction older than the explorer's window is `unknown`, never `not-bundled`; a failed lookup is `unknown` with the reason. Final answers are kept in a `PlacementStore` the first time they are read, because the explorer forgets.
2. **Guard.** `organicGuard(report, orderCount, policy, coordination)` returns `pass`, `hold` or `fail`. `fail`: at least `maxInorganicBps` of volume is shown inorganic (conflicted bidders, or a group that bid on both sides). `hold`: the evidence is incomplete (thin cross, too many untraced wallets, too many placements that could not be checked for bundles). `pass`: the lower bound and the number of independent groups clear the bar. The policy is data with a version string; the defaults are ours and unfitted, and say so.
3. **Attester.** `services/integrity` (`volume-main.ts`) runs the whole analysis for each configured governed cross and posts to `cross_graduate.post_volume` the LOWER bound, in quote atoms rounded down, only on `pass`; on `fail` it withdraws a figure it had posted (posts zero); on `hold` it says nothing. A lower figure replaces a higher one at once; a rise is posted only past `minChangeBps`, and a jump above `maxIncreaseFactor` times the last is held for an operator. It fails closed on anything it cannot read (the order list, the cross, the clearing price, the declared-team flags).
4. **One pipeline.** `analyzeCross` (orders in, guard decision out) is the same analysis the API route performs, plus bundles and the guard. The API route can adopt it unchanged (listed as an outside-ownership change); until then the route reports the interval without bundle evidence, and its `barsUnmet` says so.

## Alternatives considered
- **Treat any shared bundle as a link.** Simple, and wrong on live data: it would flag unrelated users of a relay and turn ordinary traffic into "manipulation". The payer rule is the narrowest rule that survives that sample.
- **Attest the upper bound, or the midpoint.** The charter's minimum is a promise to holders; an attester states what it can show, not what it cannot disprove.
- **Post on `hold`.** A lower bound depressed only by untraced wallets would block graduation on a rate-limited RPC. Silence is the honest signal and the next pass reads more.
- **Gate inside the program.** The program should stay minimal and frozen; policy that will be tuned belongs in an attester whose key the charter names.

## Consequences
- The measure still cannot see a wallet funded through intermediaries, volume placed outside bundles by one operator with distinct funders and no shared transaction, or any of it on a call auction whose orders were placed more than seven days before the attester first looked (the evidence is then `unknown` and the guard holds). Run the attester while the cross is live.
- Nothing here has been validated against labelled real wash trading: none exists for call auctions. The release bar for the measure (ADR-0954) says what would settle it.
- The attester signs a figure derived from the indexer's order list; the chain-checked parts are funding, placement and bundles. A compromised API could omit orders. The attester's own key is the charter's trust assumption, as ADR-0656 states.

## Evidence
`docs/evidence/W5-1F.md`: 8/8 tip accounts derived equal the block engine's list and are owned by the tip program; 40/40 live bundles' transactions resolve to their bundle and `tipIn` finds a tip in every one; wash injection that no funding trace can see is caught by the bundle link (90 tests in `packages/integrity`, 18 in `services/integrity`).
