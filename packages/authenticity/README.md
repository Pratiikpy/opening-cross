# @opening-cross/authenticity

Answers "is this the issuer's real token?" for a Solana mint.

A name is the one thing an imitator can copy for free, so the check does not trust names. It compares a mint with the issuers' own published lists **and** the keys the issuer holds on chain (mint, freeze, pause, permanent-delegate, scaled-amount and hook authorities), then looks for copies of a genuine symbol or name.

```ts
import { classifyMint, loadBundledBook, observeMint } from '@opening-cross/authenticity';
import { createSolanaRpc } from '@solana/kit';

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');
const verdict = classifyMint(loadBundledBook(), await observeMint(rpc, 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'));
// verdict.verdict === 'GENUINE', verdict.listing.symbol === 'TSLAx'
```

Verdicts: `GENUINE`, `FAMILY_UNLISTED`, `IMPERSONATOR`, `ADDRESS_LOOKALIKE`, `UNVERIFIED_STOCK_TOKEN`, `UNRELATED_TOKEN`, `NOT_A_MINT`, `UNKNOWN`. Each carries reasons in plain language. A verdict says who issued a token, never whether it is safe or a good buy. A listing never outranks the chain: a listed address whose authorities do not match the issuer's is `UNKNOWN`.

## Registry

`data/registry.json` is built only from the issuers' own sources (xStocks asset API, Ondo token CSV, and the pages where Circle, Tether and Paxos publish their stablecoin addresses), each stamped with its URL, fetch time and content hash. Rebuild it with

```sh
pnpm --filter @opening-cross/authenticity refresh
```

which reads every listed mint on mainnet and refuses to write a file if any listed address is not a token mint. Coverage is two stock issuers and four canonical stablecoins; anything else is `UNRELATED_TOKEN`.

Design and measurements: [ADR-0016](../../docs/adr/0016-token-authenticity.md). Requires Node 22 or later. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); Apache-2.0.
