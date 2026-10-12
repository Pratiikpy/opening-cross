# @opening-cross/sdk

TypeScript SDK for Opening Cross. Addresses, sealed-bid commitments and instruction builders for every step of a cross: create, place, cancel, reveal, settle, claim, finalize, plus Pyth oracle helpers and Merkle allowlists.

```sh
npm install @opening-cross/sdk
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { buildCreateCross, buildPlaceOrder, buildSettleBook, buildClaim, buildFinalize } from '@opening-cross/sdk';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
