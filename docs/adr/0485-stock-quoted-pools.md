# ADR-0485: Stock-quoted DLMM pairs and the Token Badge (X12, C1)

Status: accepted (2026-10-13)

## Context

Every listed tokenized stock carries Token-2022 extensions (pausable, permanent delegate, scaled amount, an installable transfer hook; `docs/evidence/DP14.md`). `open_dlmm_pair` passed no badge accounts, so a pair quoted in such a mint was impossible.

## Decision

`open_dlmm_pair_badged` takes the two badge accounts as remaining accounts (base then quote; the DLMM program id for "none") and forwards them to DLMM, with an optional batch window (zero for none). The adapter derives the `TokenBadge` PDA (`token_badge`, mint). Against the real DLMM binary a pair quoted in a pausable, permanent-delegate mint is refused without a badge with `UnsupportedMintExtension` and opens at P* with one.

Only Meteora can issue a badge on a real cluster, so the LiteSVM test plants the badge account; that proves the adapter's pass-through and DLMM's acceptance, not that Meteora will issue badges for any particular stock mint. That remains HUMAN_TASKS H9 / HS6. DAMM v2 pools take no badge account and were not tested with stock mints; DBC as a quote-mint host was not tested.
