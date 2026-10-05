# @opening-cross/verifier

Independent verifier. Recomputes a cross's clearing from its on-chain book with a second implementation of the clearing rule and emits a fairness proof (`opening-cross/fairness-proof/v1`). Ships the `opening-cross-verify <cross> [--rpc <url>]` command.

```sh
npm install @opening-cross/verifier
```

```ts
import { verifyCross } from '@opening-cross/verifier';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
