# @opening-cross/token-safety

Reads a mint's Token-2022 extensions and reports issuer powers (pause, permanent delegate, display multiplier, transfer hooks, fees) that affect escrowed or pooled balances.

```sh
npm install @opening-cross/token-safety
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { assessMint } from '@opening-cross/token-safety';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
