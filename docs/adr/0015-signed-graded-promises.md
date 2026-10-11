# ADR-0015: Signed, graded promises and the public accuracy record

Status: accepted (2026-10-11)

## Context

An open-book cross shows an indicative clearing price while the call is open. A visitor can reasonably ask how far to trust it. Most products answer with a confidence number that nobody can check. The aim here is the opposite: a claim that is made before the outcome is known, signed, graded against the chain afterwards, and counted in public whether it held or not.

Alternatives considered:

| Option | Why not |
|---|---|
| Show only the indicative price | It is not a promise, so nothing can be wrong about it |
| A model-based forecast interval | Needs training data the product does not yet have, and coverage claimed from a model's own assumptions is the claim we want to avoid |
| Conformal prediction on graded history | Distribution-free, needs only exchangeable errors, and each band is checkable from the published samples. Chosen |
| Full probabilistic forecast scored by CRPS | Useful once there is volume; a single price per cross does not need it yet |

## Decision

A new package, `@opening-cross/promises`, a service, `services/promiser`, and API and web surfaces.

**A promise** is a body of integers only (RFC 8785 canonical JSON, floats refused): the cross, the time bucket of its call window, the grid, the claim (point tick and a band of ticks), the outcome rule, the model and policy ids, and the hash of the book the point was computed from. Its id is the SHA-256 of that body. The promiser signs `opening-cross/promise/v1\n` + id with an ed25519 Solana key; the API publishes the signer. A stranger needs only the document to check the id and the signature (`pnpm --filter @opening-cross/promises verify <url>`), and with the published book can recompute the point.

**The point** is the price the cross would clear at if it closed now, computed by the same independent clearing implementation as the verifier. Sealed books have no indicative price, so nothing is promised for them.

**The band** is split-conformal: for a cell (time bucket), the ⌈(n+1)·nominal⌉-th smallest absolute error in ticks among graded crosses, one sample per cross per bucket (the last promise in the bucket), using only outcomes known at issuance. A band claims a coverage (default 90%) only when the cell is **CALIBRATED**: at least 30 graded crosses over at least 2 UTC days, and a prequential test on held-out samples (at least 20) that does not show under-coverage (Wilson upper bound below nominal invalidates). Over-coverage is reported, not penalised: it makes the claim true, only less sharp. Until then the promise is **PROVISIONAL**: it claims no coverage and is graded SCORED so the data to calibrate it accumulates in public.

**Grades** are HIT, MISS, SCORED, VOID (the cross never printed, with the reason) and UNRESOLVED (no outcome yet). Every promise is counted exactly once, so the hit rate cannot be flattered by dropping the awkward ones. The grade comes from the cross account the program wrote; the time of the outcome comes from the indexer's record of `CrossCleared`.

**Anchoring.** A promise is only as honest as its timestamp. Unanchored ids are folded into a Merkle root (leaf prefix 0x00, node prefix 0x01, odd node promoted) written to a Memo transaction by the promiser key. The transaction's block time bounds when each promise existed; the API serves an inclusion proof per promise.

**Surfaces.** `GET /v1/crosses/:address/promise`, `/v1/promises/:id`, `/v1/promises/:id/inputs`, `/v1/promises/signer`, `/v1/accuracy`; the cross page shows the signed band with the verdict once graded; `/accuracy` shows the per-bucket record, the target, the Wilson range and what is provisional.

## Consequences

- The band is wide or absent early and tightens only as graded crosses accumulate. The page says so instead of showing a band it cannot back.
- Time buckets share one calibration, so a cross type that behaves differently would need its own cell; the cell key already carries the room for it.
- The promiser's key is a trust root for the record. Losing it ends new promises but not old checks; rotating it publishes a new signer, and promises by any other key are not ours.
- Not covered: promises about quantities other than the clearing price, and a continuous (non-batch) venue.

## Verification

`packages/promises` (41 unit tests: canonical form, signature, quantile, gate behaviour both ways, Wilson, Merkle proofs); `tests/core/test/promiser.test.ts` (5 tests on the real `cross_core` binary with Postgres: sign, grade against the chain price, void on no print, 16-cross calibration, anchor with a memo transaction, a stranger verifying with only the document).
