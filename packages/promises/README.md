# @opening-cross/promises

Signed, graded promises: a claim made before the outcome, signed, graded against the chain afterwards, and counted whether it held or not.

A promise is a canonical JSON body of integers only (RFC 8785), identified by the SHA-256 of that body and signed with an ed25519 Solana key over `opening-cross/promise/v1\n` + id. The one kind today is `CLEAR_BAND`: where an open-book cross's final clearing price will land, as a band of grid ticks. Bands are split-conformal and claim a coverage only once enough crosses have been graded; until then they are `PROVISIONAL` and claim none. Grades are `HIT`, `MISS`, `SCORED`, `VOID` and `UNRESOLVED`, each promise counted exactly once.

## Verify a promise yourself

```sh
pnpm --filter @opening-cross/promises verify <api>/v1/promises/<id> \
  --signer <promiser address> \
  --inputs <api>/v1/promises/<id>/inputs \
  --rpc <solana rpc>
```

It checks that the id is the hash of the body, that the signature is valid for the expected signer, that the published book hashes to the promise's `inputsHash` and gives the claimed point, and, with `--rpc`, grades the promise against the cross account on chain. It exits 0 only when every check asked for passes.

Design: [ADR-0015](../../docs/adr/0015-signed-graded-promises.md). Requires Node 22 or later. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); Apache-2.0.
