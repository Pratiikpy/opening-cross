# ADR-0458: Continuous clearing is not part of `cross_core`

Status: accepted (2026-10-13), for the orchestrator to confirm. Decides PRODUCT_FEATURES W12, B3 (tag OS).

## Context

W12/B3 asks for a continuous-clearing mode in the core: per-slot checkpoints and a pool seeded at the average price paid, built after the call cross ships, "to neutralise a Uniswap CCA port".

## Decision

It does not belong in `cross_core`, and it is not built here.

1. **Different invariants.** `cross_core` proves a single sentence: one clearing price per cross, recomputable from the book by a stranger (ADR-0003, the conformance vectors, the verifier). A continuous mode clears many times, so every claim becomes a path-dependent sum over checkpoints, the verifier needs a second algorithm, and the fairness proof changes its meaning. Folding it into the same program multiplies what has to be audited (there is no audit yet, H6) without adding to what the call cross guarantees.
2. **Different failure modes.** A continuous mode is the setting where sniping, last-block ordering and per-slot manipulation are the whole game; ADR-0452's answer (a drawn end) does not apply to it.
3. **Positioning.** The specification tags the row open-source (OS), after the call cross ships. A separate program, `cross_cca`, with its own client and verifier, would let a team that wants it choose it without changing the audit scope of the program that holds every escrow.

If it is built it is a new program with a new program id, reusing `cross_core`'s vault and claim patterns, and its own ADR. Nothing in `cross_core`'s accounts blocks it.

## Consequences

W12/B3 stays NOT BUILT, with this ADR as the reason. The comparison with Uniswap CCA stays in the research notes.
