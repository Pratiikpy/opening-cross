# @opening-cross/cross-settle-client

Generated `@solana/kit` client for `cross_settle`: settlement adapters that open Meteora DBC, DAMM v2, DLMM and Raydium CPMM markets at a cross's clearing price.

```sh
npm install @opening-cross/cross-settle-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getSeedDammV2Instruction } from '@opening-cross/cross-settle-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
