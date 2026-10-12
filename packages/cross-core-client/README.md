# @opening-cross/cross-core-client

Generated `@solana/kit` client for the `cross_core` program: accounts, instructions, events, errors and PDA helpers, produced by Codama from the program's IDL (included under `idl/`).

```sh
npm install @opening-cross/cross-core-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { CROSS_CORE_PROGRAM_ADDRESS, getCrossDecoder } from '@opening-cross/cross-core-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
