# @opening-cross/cross-gate-client

Generated `@solana/kit` client for `cross_gate`: eligibility passes for gated crosses (allowlist, Solana Attestation Service, Merkle allowlist).

```sh
npm install @opening-cross/cross-gate-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { getClaimPassMerkleInstruction } from '@opening-cross/cross-gate-client';
```

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
