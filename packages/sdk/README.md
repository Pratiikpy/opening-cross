# @opening-cross/sdk

TypeScript SDK for Opening Cross. Addresses, sealed-bid commitments and instruction builders for every step of a cross: create, place, cancel, reveal, settle, claim, finalize, plus Pyth oracle helpers and Merkle allowlists.

```sh
npm install @opening-cross/sdk
```

```ts
import { buildCreateCross, buildPlaceOrder, buildSettleBook, buildClaim, buildFinalize } from '@opening-cross/sdk';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
