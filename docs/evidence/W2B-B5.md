# B5 minimum raise and the accepted amount, issuer side (2026-10-13)

Outcome: BUILT for the issuer UI over the existing `min_matched` and the supply schedule. NEEDS-PROGRAM for two parts of the specification (below).

## What exists

The wizard's guards panel (`components/issue-wizard/guards-panel.tsx`, ADR-0355):

- "Accepted amount": before signing, the range of outcomes the program will accept: the fewest tokens that let the cross print (the effective minimum volume, including any float rule) and the most (the supply listed in a minting cross), with the quote raised at the lowest and the top price.
- A raise target in quote tokens becomes a minimum volume at the issuer's lowest price, rounded up so the raise is never below the target (`minMatchedFromRaise`, tested: minimal and never below).
- A minimum above the supply listed fails readiness, because the cross could never print.

Browser (`e2e/issuer-wizard.mjs`): a 360 quote target at the lowest price 1.00 sets the minimum to 360 tokens; a minimum of 1,500 against 1,000 listed fails; the created devnet cross carries `minMatched = 473684211` (with a 5% float rule applied on top; `W2B-B13.md`).

## Needs a program change

1. "Refunds need no claim": today a refund is paid by a permissionless claim crank. Pushed refunds need a change to `claim` or a settlement sweep.
2. "The issuer chooses the accepted amount": the program has no instruction that lets the issuer accept less than what cleared after the fact. The issuer's choice today is made before the call (the supply listed and the minimum volume).

## Not covered

Insider-linked bids excluded from the minimum raise (VM7).
