# ADR-0503: What the verifier establishes about an ending, and what it does not

Status: accepted (2026-10-14). Builds on ADR-0452 and the fairness proof of OCIP-1 section 13.

## Context

For a cross with a drawn ending the clearing depends on which orders were counted: the buckets up to a drawn one, the extension's shards. The v2 proof already reproduced the guards, the classes, the lottery start and the insider bound. It did not say which shards were merged, nor check the drawn bucket.

## Decision

The proof of a cross with rules (schema `opening-cross/fairness-proof/v2`, now with a published JSON Schema) adds `rules.ending`, `rules.checks` and `rules.limits`:

- `main-shards-merged` and `aux-shards-merged`: the merged masks equal what the program requires for the recorded last counted bucket and epoch (`CrossExt::required_aux`). A mismatch is a defect of the clear and makes the proof not verified.
- `ending-drawn`: the recorded last counted bucket equals the first word of the seed modulo the number of buckets. The seed on the account is the last draw's; after a drawn extension the ending's seed is gone from the account, so the check is `null` (not verifiable) until the `DrawFinished` event is supplied, which `GET /v1/crosses/:address/proof/draws` does from the index.
- `limits`: the block hashes behind a draw cannot be re-read (the `SlotHashes` sysvar keeps 512 slots), so the proof checks what the seed decides and not that the draw was honest; a no-print reason that depends on the asset's state at the clear (Halted, CorporateAction, IssuerPaused) or on an oracle update cannot be reproduced from the book; per-order fills are a wallet's receipt, not this proof.

`fairness-proof/v1` is unchanged and is still served for a cross without rules (a test pins it). v2 was already served for crosses with rules; this adds fields only, so nothing that read v2 breaks (both schemas allow unknown properties).

## Conformance v3

`conformance/v3.json` covers the functions that decide which orders the clear sees: placement, required shards, exclusion by the draw, the three words of a seed, lock vesting. `crates/clearing-core` computes none of them, and `cargo` was not built on the machine, so the file is not generated from Rust: `generate_v3.py` computes it with Python integers from the specification and the program source, and the file's `source` field says so. Its placement cases tagged `rust-unit-test` are the assertions of the Rust unit test. Three implementations are run against it (Python, `packages/verifier/src/ending.ts`, the helpers of the client package). If the program's behaviour differed from its documentation, v3 would not catch it; the LiteSVM suites would.

## Evidence

`packages/verifier/test/ending.test.ts` (5), `packages/verifier/test/ruled-proof.test.ts` (9), `services/api/test/rules-read.test.ts` ("the proof with the draws").
