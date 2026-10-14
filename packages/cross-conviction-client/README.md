# @opening-cross/cross-conviction-client

Generated `@solana/kit` client for `cross_conviction`: lock tokens with no early exit and mint a soulbound badge that measures the token-days held locked.

```sh
npm install @opening-cross/cross-conviction-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getLockTokensInstruction } from '@opening-cross/cross-conviction-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
