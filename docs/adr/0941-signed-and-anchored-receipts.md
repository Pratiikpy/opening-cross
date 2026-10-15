# ADR-0941: Receipts are signed and anchored by a separate attestation

Status: accepted (2026-10-16). Builds on ADR-0015 (the promise anchor), ADR-0318 (signed documents) and `docs/standard/receipt-v1.md`.

## Context

The shareable receipt (row S2) is a recomputation bound to its content by a SHA-256 hash. It says plainly what it is not: no key signs it, and nothing shows when its hash existed. Anyone can rebuild the same bytes, so the hash is reproducible, but a quoted receipt proves nothing about who stood behind it or when.

## Decision

The receipt is not changed. Every receipt hash already shared stays what it was, and the receipt still says it is hash-bound. A separate document, `opening-cross/receipt-attestation/v1`, adds a key and a time.

**The document** has the shape of every signed document in `@opening-cross/attest`: `{ body, id, signer, signature }`. The body is `{ schema, cluster, cross, receiptSchema, receiptSha256, state, statement }`, all strings; `id` is the SHA-256 of its canonical JSON; the signature is Ed25519 by the promiser's key over `schema + "\n" + id`, so it cannot be accepted as any other kind of document. `state` is `Finalized` or `NoPrint` only: a receipt of a cross that can still change is never attested. `statement` is carried in the document: the signer fetched the receipt, found its bytes canonical and its recorded result equal to the cross account, and found its recomputation flag true; it attests the hash, not that the clearing rule was applied correctly. The signer is the key the API already publishes at `/v1/promises/signer`.

**Before signing** (`services/promiser/src/receipt-round.ts`) the promiser fetches `/receipt/<cross>/json` from the web app, and refuses (with a named reason, and no signature) unless: the body is canonical and hashes to `x-receipt-sha256`; the schema is receipt v1 or v2, the cross and network are right and it is a cross receipt (no wallet); the result is final; `recomputedMatchesChain` is true; and the result (state, printed, price, matched, rationed side) equals what the promiser reads from the cross account itself. The last check is why the signature means more than "the web app said so". A cross that cannot be attested is not retried at once (two minutes for a transient reason, an hour for a verdict about the receipt), so it cannot crowd out others. An attested receipt is fetched again after six hours; if its bytes changed, a second attestation is added and the first is kept.

**The anchor** is the promise anchor again (ADR-0015): attestation ids are folded into a Merkle root (leaf prefix 0x00, node prefix 0x01, odd node promoted) and a Memo transaction by the same key writes `opening-cross/receipts/v1 root=<hex> n=<count>`. The prefix differs from the promise digest, so one can never be read as the other. The transaction's block time bounds when each attestation existed; the API serves the proof. Anchor and members are recorded in one statement, so a crash cannot leave one without the other, and the API refuses to serve an anchor whose stored members no longer hash to its root.

**Surfaces.** `GET /v1/crosses/:address/receipt-attestation[?optional=1]` (the answer is `receiptAttestationAnswer` in the promiser package; schema `receipt-attestation-view.v1.schema.json`); `GET /receipt/<cross>/attestation` on the web app (the same view with the checks repeated there); and a "Signed and anchored" panel under the receipt. The tables are created on first use. JSON Schemas: `receipt-attestation.v1.schema.json` and `receipt-attestation-view.v1.schema.json`, with fixtures captured from a real run.

**The page does not trust the API's word.** For an attestation it repeats, in the server render: the id against the body; the Ed25519 signature; the signer against the published key; the attested hash against the receipt it is showing now; the Merkle proof against the root; and the anchor transaction, read from a Solana RPC, for the memo and for the signer. Each check shows verified, failed or not checked; a check that could not be made is never shown as passed. Any failure heads the panel "Do not rely on this attestation". A wallet's receipt says its own order list changes when orders are claimed and carries no signature, and links to the signed cross receipt.

## Alternatives considered

- Sign inside the receipt. Rejected: it changes every receipt hash already shared, and a document cannot contain its own hash.
- Attest wallet receipts too. Rejected: they change when an order is claimed, so the signed hash would go stale.
- One Memo per receipt. Rejected: one transaction per cross is cost and noise; the batch gives the same bound.
- Build the receipt in the promiser. Rejected: two builders of the same document drift. The web app stays the one builder; the promiser verifies what it served against the chain.

## Consequences

- The promiser's key becomes a trust root for receipts as well as promises. Rotating it publishes a new signer; earlier attestations still verify against the key that signed them.
- The attestation vouches for Opening Cross's own recomputation. It is not independent: a reader who wants that runs `opening-cross-verify`.
- Deployment: the promiser needs `RECEIPT_URL` (or `WEB_URL`); without it the receipt rounds are off and the process says so. The API needs the route wired (`receiptAttestationAnswer`, three lines in `server.ts`), which is not part of this change.

## Not covered

A cross that settled without a print was attested in tests with real cross accounts but not on devnet, where the index lists none. Mainnet. A second promiser instance racing the first (the rounds assume one).
