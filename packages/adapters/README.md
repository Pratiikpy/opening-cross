# @opening-cross/adapters

Client-side helpers for Opening Cross settlement adapters: Meteora DBC, DAMM v2, DLMM and Raydium CPMM account derivations and instruction assembly.

```sh
npm install @opening-cross/adapters
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import * as adapters from '@opening-cross/adapters';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
