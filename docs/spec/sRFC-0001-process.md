# sRFC-0001: How OCIP changes

| | |
|---|---|
| Identifier | `sRFC-0001` |
| Type | Process |
| Status | Draft |
| Created | 2026-10-13 |
| Applies to | [OCIP-1](OCIP-1.md) and the schemas and vectors it names |

This document says how a change to the Opening Cross Interface Protocol is proposed, reviewed, recorded and made conformant. It follows the way the repository already records decisions: a decision is an ADR in [`docs/adr`](../adr) with a status, a context, a decision and its consequences, and evidence is a file in [`docs/evidence`](../evidence). An sRFC is the proposal that comes before that decision when the change touches the standard.

"sRFC" here names this repository's own proposals, numbered from 0001. It is not the numbering of the Solana ecosystem's sRFC discussions (for example sRFC-37, Token ACL, which `cross_gate` implements). A post to that external forum is a separate step and has not happened (`docs/HUMAN_TASKS.md`, HD3).

This process has not yet been used for a change. The review period below is a proposal of this document, not an observed practice.

## 1. What needs an sRFC

| Change | sRFC required | Revision effect |
|---|---|---|
| Any change to the clearing rule, rounding, fees, the commitment or shard functions, a seed, an account layout or an instruction's arguments | Yes | Breaking: a new OCIP major (`OCIP-2`) if it alters a published vector's outcome or a layout (OCIP-1 §18); otherwise a new revision |
| A new instruction, event, error, account type or schema | Yes | New revision |
| A new conformance vector file | Yes | New revision |
| A clarification that changes no behaviour | No: an ordinary pull request | New revision |
| A correction where the specification and the reference implementation disagree | An issue first; an sRFC if the fix changes the implementation's behaviour | New revision |
| The non-normative appendices | No | New revision |

## 2. Status values

```json ocip:srfc-statuses
["Draft", "Review", "Accepted", "Final", "Rejected", "Withdrawn", "Superseded"]
```

| Status | Meaning |
|---|---|
| Draft | Written and open for comment. Nothing is promised |
| Review | Complete: specification text, compatibility analysis, vectors and the reference-implementation change are attached. A review period is running |
| Accepted | The maintainers have decided to adopt it and recorded the decision in an ADR. The implementation is not yet merged |
| Final | The reference implementation, the vectors and the OCIP text are merged and the OCIP revision is published |
| Rejected | Decided against, with the reason in the sRFC |
| Withdrawn | Withdrawn by its author |
| Superseded | Replaced by a later sRFC, named in the header |

A status moves only forward along `Draft`, `Review`, `Accepted`, `Final`, except that any status before `Final` may become `Rejected`, `Withdrawn` or `Superseded`.

## 3. Writing an sRFC

Create `docs/spec/sRFC-NNNN-<slug>.md` with the next free number. The header has: identifier, title, type (normative change, new schema, vectors only, process), status, author, created date, the OCIP revision it amends and, if any, the sRFC it supersedes. The body has these sections, each present even if it says "none":

1. **Motivation.** What cannot be done, or is done wrongly, today, with evidence.
2. **Specification.** The exact new or replaced text, in RFC 2119 language, for each OCIP section it touches.
3. **Compatibility.** Whether it is breaking or compatible under OCIP-1 §18, and what existing programs, indexers, keepers and verifiers must change.
4. **Security considerations.** What new states or powers it creates. A change that moves funds or changes who may call an instruction needs a threat-model entry (`docs/security/THREAT_MODEL.md`).
5. **Conformance.** The vectors that pin the change (section 5), or the reason none are needed.
6. **Reference implementation.** The files and tests that change.
7. **Alternatives considered** and why they were not chosen.
8. **Unverified claims.** Anything the proposal asserts that it has not tested, marked NOT VERIFIED.

## 4. Review

1. The proposal is opened as a pull request containing the sRFC. Discussion happens on the pull request.
2. A proposal moves to `Review` when sections 2 to 6 are complete. The proposal states a review period; for a normative change it SHOULD be at least 14 days.
3. A reviewer checks, and the reviewer's comment says that they checked:
   - the specification text agrees with the reference-implementation change;
   - no published vector's expected value changes, or the change is declared breaking;
   - the independent TypeScript reference (`packages/verifier`) and the Rust crate (`crates/clearing-core`) agree on the new vectors, written separately and not from each other;
   - `tests/core/test/ocip-spec.test.ts` passes;
   - the status statements (devnet only, no audit) are unchanged or still true.
4. Acceptance is recorded as an ADR in `docs/adr` that cites the sRFC (status `accepted`, with context, decision, consequences and evidence). The sRFC links the ADR and moves to `Accepted`.
5. The sRFC is `Final` when the OCIP text, the vectors and the reference implementation are merged and the OCIP revision and changelog (OCIP-1 Appendix C) name the sRFC.

Who decides is not yet defined beyond this: today the repository's maintainers are the only decision makers. The product specification asks for a standard governed so that other venues can adopt it without trusting the maintainers (`PRODUCT_FEATURES.md`, W13). The mechanism for that, such as an editors group that includes adopters, is **not specified** and is an open item for a later sRFC.

## 5. Adding conformance vectors

The clearing vectors are `packages/verifier/conformance/v1.json` (OCIP-1 §16). To add vectors:

1. Add the cases to the generator, `crates/clearing-core/examples/conformance_vectors.rs`, which writes expected values from `clearing-core`, the code that runs on chain, following `cross_core::clear` step for step.
2. A change that adds cases without altering existing ones goes in a **new file** (`v2.json`, with its own schema string if its format differs). A published file is never edited. A change that would alter an existing case's expected value is breaking and needs `OCIP-2` and a new schema version.
3. Regenerate and check that CI's comparison holds: `cargo run -q --release -p clearing-core --example conformance_vectors` must reproduce the committed file byte for byte.
4. Run the independent reference over the file: `pnpm --filter @opening-cross/verifier conformance`. It must report zero failures. A case the reference gets wrong is either a bug in the reference or a specification question; it is not removed to make the run pass.
5. Run the cases on the deployed program (`tests/core/test/conformance.test.ts`, LiteSVM, Linux). Cases the program cannot represent (limits of account size) are listed with the reason, as in `docs/evidence/D5-conformance.md`.
6. Update the count and path in the `ocip:conformance` block of OCIP-1 §16, and the changelog. The spec test fails until they agree.

Vectors for the other formats (promises, hashes, the sample fairness proof) live in the fenced `ocip:` blocks of OCIP-1 and are reproduced by `tests/core/test/ocip-spec.test.ts`. A change to those formats updates the block and the test in the same pull request.

## 6. Editing OCIP-1

Every change to `OCIP-1.md` raises its revision number, adds a row to Appendix C and cites the sRFC or pull request. Before merging, run from the repository root:

```
pnpm --filter @opening-cross/core-tests exec vitest run test/ocip-spec.test.ts
```

The test reads the document and the program sources only; it needs no validator and no LiteSVM, and it runs on Windows. It does not check prose. A reviewer reads the prose against the code.

## 7. Defects

A disagreement between OCIP-1 and the reference implementation is reported as an issue that names the section and the code. While the reference implementation is the only implementation, its deployed behaviour stands until the issue is resolved; the resolution is either a correction to the text or, through an sRFC, a change to the code.
