# @opening-cross/cross-basket-client

Generated `@solana/kit` client for `cross_basket`: baskets: a share token backed by fixed amounts of several tokens, minted and redeemed against the vaults by anyone.

```sh
npm install @opening-cross/cross-basket-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getMintSharesInstruction } from '@opening-cross/cross-basket-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
