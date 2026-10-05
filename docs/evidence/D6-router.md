# D6 — Best-execution router (2026-10-05)

`packages/router`: `quoteCross` re-runs the clearing rule on a live open cross's book, summing
the merged book with every unmerged shard and adding the user's order. It returns the indicative
price, this order's fill and the quote paid or received net of fees (buyers pay
`ceil(fill·P/scale)`; sellers receive the floor less `protocol+integrator` bps, as in
`cross_core::claim`). `quoteJupiter` takes a live Jupiter route for the same size (ExactOut for
buys, ExactIn for sells). `bestExecution` puts both into an `opening-cross/best-execution/v1`
report with prices in the cross's units, the difference in bps, a recommendation and caveats.

## Live test (`tests/core/test/router.test.ts`)
The real mainnet USDC and JUP mint accounts are loaded into LiteSVM, with the mint authority
handed to the test. An open reopen cross is built on a 10 bps grid around Jupiter's live
USDC→JUP price, with resting sellers and a competing bid. The router then priced a 100 JUP buy
against a live Jupiter route at the same moment (2026-10-05T14:09:48Z, Jupiter context slot
453602050):

```
cross:  P* 334776, fill 100000000, quote 33477600  (open, fee 0 bps)
dex:    Whirlpool → Whirlpool, 33410812 USDC atoms for 100 JUP (impact 0.0013%)
comparison: crossPrice 334776, dexPrice 334109, crossBetterByBps -19 → recommendation "dex"
```

The prediction was then executed: the order was placed, the book settled, the order claimed.
The realized clearing price, base received and quote spent equal the router's figures exactly.

Also covered:

- A sealed cross yields no indicative price, with the caveat saying why.
- A closed call, an off-grid limit, a missing account and a non-cross account (a wallet; the
  real USDC mint) are each reported as unavailable with the reason.
- An unroutable pair returns Jupiter's own HTTP error in the report, and the recommendation is
  `none`.

Full suite: 20 files, 93/93.

Findings fixed while testing:

- The router first read only the merged book. A live cross's orders rest in its shards until
  settlement, so it reported "no print".
- A non-cross address crashed the decoder. Accounts are now checked for owner and discriminator.

Scope note: the cross side here is a LiteSVM book on real mints, because no mainnet cross exists
before launch (L4). Comparing against a mainnet cross at the same moment repeats this test with
the chain as the source; the code path is the same.
