# ADR-0601: Receipts of crosses with rules are version 2

Status: accepted (2026-10-14). Builds on ADR-0503 and the receipt of OCIP-1.

## Context

`GET /v1/crosses/:address/proof` answers `fairness-proof/v2` for a cross that carries rules. The receipt (`opening-cross/receipt/v1`) fixes `verification.proofSchema` to `fairness-proof/v1` in its published schema. Built from a v2 proof, the page would have written `proofSchema: .../v2`, a document its own published schema refuses, and would have dropped the rules checks, the draw and what the proof cannot establish.

## Decision

A proof of schema v1 gives the receipt it always gave, byte for byte (no `rules` key, same hash). A proof of schema v2 gives `opening-cross/receipt/v2`: v1 plus a `rules` block (`checks`, `ending`, `draw`, `allocation`, `limits`, copied field by field so nothing outside the schema reaches the document), `proofSchema` fixed to v2, and a method sentence that names the extra re-derivations. A proof with any other schema, or a v2 proof without its rules block, is refused with a sentence; it is never summarised as v1. `packages/verifier/schema/receipt.v2.schema.json` publishes the shape. The card shows how many checks on the rules reproduced and which ending window the draw fixed, and no-print reasons are shown in words.

## Evidence

`apps/web/test/holder-receipt-v2.test.ts`: v2 validates against its schema and is refused by v1's, v1 is unchanged, an unknown schema throws, the hash moves when the rules block moves, all fourteen no-print reasons have words.

## Not covered

The CLI verifier (`opening-cross-verify`) does not read receipts. `docs/standard/receipt-v1.md` is not updated; this ADR is the description of v2.
