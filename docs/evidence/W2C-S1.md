# W2C-S1: price-discovery view, final window, own orders from the chain

Outcome: **BUILT**. Design: ADR-0408. Code: `components/cross/holder-coarse.ts`, `hero.tsx`, `my-orders.tsx`, `book-chart.tsx`; API `services/api/src/routes/holder-terms.ts` (`GET /v1/orders/:address/terms`).

## Coarse final window

In the last quarter of an open call (never more than ten minutes) the hero shows the indicative price as a range of whole price steps (about an eighth of the grid) and demand against supply in five buckets, with a notice that this is a display choice only and a button to show the exact figures. The program is unchanged: it has no hidden or coarse window, and the page says so. A random end, a cancel cutoff and coarse buckets inside the chart are program changes (B14) and are not claimed.

## An order's price from the chain

An open order's price is an argument of its `commit_order` instruction, not stored on the order account. `GET /v1/orders/:address/terms` reads the order's first transaction from the cluster and decodes it with the indexer's own `commitTerms`. The chart uses it for the connected wallet's orders that the index does not price yet (about the first minute); sealed orders stay off the chart until revealed.

## Tests

`apps/web/test/holder-coarse.test.ts` (4 tests: range on the grid, edges, clamping, the five buckets), `services/api/test/holder-terms.test.ts` (3 tests: decode, caching, sealed, unreadable, refusals).

## Devnet run (`apps/web/e2e/holder-sponsor-live.mjs`, cross `8WGUv8o7NcJFWhUzaV2DmJdYiXn6NeysNiRTvCJvaAj6`)

```
PASS the chart marks the wallet's own order at 1.2, its price read from the chain
PASS final window: the price is shown as a range (about 1.16 to 1.24)
PASS final window: the notice says this is display only
PASS final window: Show exact figures gives the exact price
PASS cross page in its final window: axe clean
```

The order had just been placed, so the index did not price it; the chart marked it from the chain. The exact price was 1.2, inside the range shown. Screenshots read: `screens/w2c/final-window-coarse-1440-light.png`, `book-own-order-1440-light.png`.

Not covered: the chart in the final window rounding its levels (only the hero rounds); a sealed cross's final window; the range on a grid with fewer than eight levels (unit-tested, not browsed).
