# @opening-cross/router

Best-execution routing for Opening Cross. For one buy or sell it prices two venues at the same
moment, net of fees: the indicative result of joining an open cross (the clearing rule re-run on
the live book, shards included, with your order added) and a live Jupiter route for the same
size. It returns an `opening-cross/best-execution/v1` report with both quotes, the difference in
basis points, a recommendation and every caveat that applies (sealed books, partial fills, the
cross settling later than an immediate swap).

```ts
import { bestExecution, quoteCross, quoteJupiter } from '@opening-cross/router';
```

Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
