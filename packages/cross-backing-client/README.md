# @opening-cross/cross-backing-client

Generated `@solana/kit` client for `cross_backing`: a watchdog that halts an asset on chain when its attested backing is missing, stale or below the issuer-chosen coverage of the live supply.

```sh
npm install @opening-cross/cross-backing-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getCheckInstruction } from '@opening-cross/cross-backing-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
