# @opening-cross/cross-bounty-client

Generated `@solana/kit` client for `cross_bounty`: a committed bounty pool that pays automatically when a cross account breaks an invariant, and by an arbiter for what the chain cannot check.

```sh
npm install @opening-cross/cross-bounty-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getClaimInvariantInstruction } from '@opening-cross/cross-bounty-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
