# ADR-0915: Rebalancing the conviction ladder (W10)

Status: accepted (2026-10-16) · Builds on ADR-0483, ADR-0914

## Context

W10 is "opt-in pools paused and rebalanced to P*". The pause is the pool's activation point (ADR-0483). Meteora has no instruction by which a third party acts on another's position, so a rebalance that a protocol performs on its own is not possible; the one that is possible is the issuer's, on the ladder the issuer laid. That is also where the need is: buyers who walk the price up through a ladder leave it holding quote in the bins that sold and base in the bins that did not, spread over bins the market has already passed.

## Decision

- `decodeDlmmPosition`, `decodeDlmmBinArray`, `dlmmPositionAmounts` and `ladderStatus` (`packages/adapters/src/dlmmpos.ts`, `rebalance.ts`) read a ladder: what each bin is worth to the position (floor of `amount x shares / supply`, as the program pays), whether the market has reached it, how much base is left and how much quote it earned.
- `buildRebalanceLadder` returns two transaction groups. **Withdraw**: claim the position's fees, remove all its liquidity, close it. **Relay**: open a new position above the new active bin and lay the withdrawn base in the same shape. The relay is sent after the withdrawal has landed, because it spends the base the withdrawal returns. Every step is Meteora's instruction signed by the issuer.
- The API: `ladder-rebalance-withdraw` (refuses with a reason when the ladder is untouched, sold out, locked or not the caller's), `ladder-rebalance-relay`, and `GET /v1/crosses/:address/ladder`. The amount for the second step comes from the first step's response, not from the screen. The issuer page has both steps (`apps/web/src/app/issuer/settle/meteora-more.tsx`).

## Verified against the real binary

A 30-bin ladder of 2,999,999,985 base: the decoded position matched what went in to within the rounding of DLMM's shares (15 atoms); a buyer's 1,500,000,000 quote moved the active bin from 182 to 195 and bought 1,240,634,301 base; the reading (1,759,365,684 base left, 1,498,072,815 quote earned) added to the base bought gives exactly the 2,999,999,985 laid; the withdrawal returned exactly the base the reading predicted, closed the position and returned its rent; the relay laid the base at bins 196 to 225 (the first above the new market) and the three amounts, wallet, new ladder and buyer, add up to the base laid to within 14 atoms of rounding; a second buyer paid no less than the new first bin's price. DLMM refuses a withdrawal in the second the liquidity was added (`LiquidityLocked`); the test waits a minute. A stranger cannot withdraw the issuer's position. The same two steps run through the API against the real binaries.

## Not covered

A ladder in a pair whose bin arrays do not all exist (the relay creates the missing ones), a hooked base through the withdrawal (the accounts are built and not exercised), a rebalance of a locked ladder (refused until the release time, ADR-0914), fees in token X (the pair charged them in quote on a quote-in swap), and any run on a cluster (H27). No keeper tells an issuer that its ladder has been walked into, and none rebalances for it.
