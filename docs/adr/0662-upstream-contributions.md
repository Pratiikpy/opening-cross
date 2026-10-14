# ADR-0662: Upstream contributions to Meteora (R3) are a human step

Status: accepted (2026-10-14)

## Context

[R3] "Contribute upstream: open presets, SDK fixes, demand-calibrated curve builder and transfer-hook template to MeteoraAg repos and Invent/Fun Launch." ADR-0486 recorded it as human-gated.

## Decision

Nothing here is code that belongs in this repository's programs. A contribution is a pull request from a person's GitHub account to a repository of another organisation, accepted or not by its maintainers, under their licence and review. An agent cannot make that account's commitment, speak for the project to the maintainers or agree to a contributor licence.

What is in this repository that a person could offer, and where to look: the preset registry (`packages/preset-registry`) and the presets (`packages/presets`) for Invent/Fun Launch's configuration; the volatility-fee parameters (`docs/evidence/DP-volatility-fee.md`); the `cross_gate` transfer hook and `examples/venue` as a hook template; and any SDK defect found while building the adapters, each with its failing case. Which of these Meteora's maintainers would take is theirs to say, and this ADR does not claim a particular one is ready: that is the first thing the person sending them decides. Meteora's repositories carry their own licences (ADR-0486 and `research/repos/INDEX.md` list them) and a contribution is made under the receiving repository's terms.

## Consequences

R3 is a HUMAN row: the single step is a founder-account pull request per item, after reading the receiving repository's contribution guide. Nothing is blocked on code.
