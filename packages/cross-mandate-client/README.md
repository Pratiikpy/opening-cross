# @opening-cross/cross-mandate-client

Generated `@solana/kit` client for `cross_mandate`: auto-invest mandates in which an agent places buy orders inside limits the owner set on chain (per-order size, lifetime cap, share of a cross's supply, expiry, allow list), and the owner can revoke and withdraw at any time.

```sh
npm install @opening-cross/cross-mandate-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getPlaceOrderInstruction } from '@opening-cross/cross-mandate-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
