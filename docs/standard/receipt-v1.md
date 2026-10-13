# Opening Cross receipt, version 1

Status: draft, implemented by the Opening Bell web app. Schema identifier `opening-cross/receipt/v1`. JSON Schema: [`packages/verifier/schema/receipt.v1.schema.json`](../../packages/verifier/schema/receipt.v1.schema.json). The document it builds on, the fairness proof, is specified in [OCIP-1](../spec/OCIP-1.md) section 13 and has its own schema, [`fairness-proof.v1.schema.json`](../../packages/verifier/schema/fairness-proof.v1.schema.json).

## What a receipt is

A receipt is one JSON document about one settled cross. It restates three things and nothing else:

1. **The result the chain recorded**: state, whether the cross printed, the clearing price, the matched volume, the rationed side, or the no-print reason. These are the `onchain` fields of the fairness proof.
2. **The verdict of an independent recomputation**: whether a second implementation of the clearing rule, run on the cross's on-chain book, reproduced that result (`recomputedMatchesChain`). This is the `verified` field of the fairness proof, together with the SHA-256 of the whole proof the receipt was built from (`proofSha256`).
3. **Where the result was recorded**: the signature, slot and block time of the `CrossCleared` and `CrossFinalized` transactions, from the cross's event log (`anchors`).

A wallet receipt adds that wallet's own orders in the cross (`wallet`): side, escrow, limit price and quantity where the index holds them, status, fill, tokens out, quote out and fee.

It is served by the Opening Bell web app:

| URL | Content |
|---|---|
| `/receipt/<cross>` | The page: the card, what it shows, the anchors, how to check it |
| `/receipt/<cross>/<wallet>` | The same for one wallet's orders |
| `/receipt/<cross>/image` and `/receipt/<cross>/<wallet>/image` | The card as a 1200 by 630 PNG, also the page's `og:image` |
| `/receipt/<cross>/json` and `/receipt/<cross>/<wallet>/json` | The receipt as canonical JSON, with its hash in the `x-receipt-sha256` header |

A cross that has not settled has no receipt: the JSON answers 409, the image says "Not settled yet", and the page offers no card for sharing.

## What it does not claim

Every receipt carries these statements in its `limits` array, so the document cannot be quoted without them.

- **It is a recomputation, not a zero-knowledge or multi-party proof.** Anyone can repeat it. There is no cryptographic argument that hides anything or that holds without re-running the rule.
- **It is bound by a hash, not signed.** No key signs a receipt. The SHA-256 below ties the document to its content, and the anchors tie it to transactions that anyone can look up, but nothing proves who produced the document. A receipt is evidence only to the extent a reader re-checks it.
- **It does not show** that the book equals the sum of the orders placed, that each individual fill and payment equals the rule's value, that the oracle verdict (where a cross has an oracle guard) was correct, that the tokens are what their issuer says, or that the program on chain equals the repository's source. OCIP-1 section 13.4 states the same limits for the proof.
- **Order figures are the index's.** The `orders` counts and the `wallet` orders come from the chain index (`GET /v1/crosses/:address/orders`), which a reconciler compares with the chain; they are not part of the recomputation.

## Canonical form and the hash

The receipt contains no timestamp of its own and no randomness. Times that appear (`anchors[].time`) are block times recorded for events that already happened. The same cross therefore always yields the same document.

The bytes of a receipt are its **canonical JSON**: UTF-8, every object's keys sorted by code unit order, no whitespace between tokens, strings and numbers written as `JSON.stringify` writes them, `undefined` members omitted, non-finite numbers refused. The **receipt hash** is the lowercase hexadecimal SHA-256 of those bytes. It is not inside the document (a document cannot contain its own hash); it is shown on the page and sent as `x-receipt-sha256`. The body of `/receipt/<cross>/json` is exactly the canonical bytes, so:

```sh
curl -s https://<site>/receipt/<cross>/json | sha256sum
```

prints the receipt hash. `verification.proofSha256` is the same function applied to the fairness proof as `GET /v1/crosses/<cross>/proof` serves it:

```js
const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
// sha256 of canon(JSON.parse(proofText)), hex
```

## Checking a receipt

1. Hash the bytes you were given and compare with the receipt hash.
2. Fetch the proof, hash it the same way, and compare with `verification.proofSha256`.
3. Re-run the recomputation yourself instead of trusting `recomputedMatchesChain`: `opening-cross-verify <cross>` (see the verifier package) reads the cross and its book from a cluster RPC and prints the proof; exit code 0 means `verified`.
4. Look up each `anchors[].signature` on a cluster explorer and confirm that the transaction invokes `cross_core` and that its event reports the same price and matched volume.

Steps 1 and 2 show that a document is the one the site would build. Steps 3 and 4 are what make it evidence.

## Schemas and versioning

`receipt.v1.schema.json` forbids unknown properties: a receipt is a closed document so that the hash covers a known shape. A change that adds, removes or retypes a field is a new schema version (`opening-cross/receipt/v2`). The fairness proof schema follows OCIP-1's rule instead: its version-1 schema allows unknown properties, because adding an optional field to a proof does not need a new version.

`packages/verifier/schema/schema.test.ts` validates real proofs against the proof schema (captured from the devnet API and fetched live), and `apps/web/test/receipt.test.ts` validates receipts built from real devnet data against the receipt schema and checks the hashes against Node's own SHA-256.

## What would make it stronger

Not built, and not claimed: a signature by a published key (so a receipt could be attributed), an on-chain anchor that commits to the receipt hash itself (so its existence at a time could be shown), and a succinct proof of the clearing computation. Each is a decision about keys or on-chain cost, not a gap in the receipt as it is specified here.
