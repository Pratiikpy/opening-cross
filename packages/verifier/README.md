# @opening-cross/verifier

Independent verifier. Recomputes a cross's clearing from its on-chain book with a second implementation of the clearing rule and emits a fairness proof (`opening-cross/fairness-proof/v1`). Ships the `opening-cross-verify <cross> [--rpc <url>]` command. From a clone of the repository: `pnpm --filter @opening-cross/verifier verify <cross> --rpc <url>`, and `pnpm --filter @opening-cross/verifier conformance` for the 525 conformance vectors.

```sh
npm install @opening-cross/verifier
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { verifyCross } from '@opening-cross/verifier';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
