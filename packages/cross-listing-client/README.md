# @opening-cross/cross-listing-client

Generated `@solana/kit` client for `cross_listing`: venue listing bonds: stake to list crosses, get the bond back when they end well, lose it to a settlement that never happened.

```sh
npm install @opening-cross/cross-listing-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getListCrossInstruction } from '@opening-cross/cross-listing-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
