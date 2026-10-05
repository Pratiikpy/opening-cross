# @opening-cross/token-safety

Reads a mint's Token-2022 extensions and reports issuer powers (pause, permanent delegate, display multiplier, transfer hooks, fees) that affect escrowed or pooled balances.

```sh
npm install @opening-cross/token-safety
```

```ts
import { assessMint } from '@opening-cross/token-safety';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
