# @opening-cross/integrity-service

Two processes built on `@opening-cross/integrity` and `@opening-cross/research`.

**Organic-volume attester** (`pnpm start:volume`, ADR-0950). For each governed cross in its config whose open round names this key as the volume attester, it runs the organic-volume analysis (funding clusters, Jito bundle evidence, conflicts), applies the guard, and posts the LOWER bound in quote atoms to `cross_graduate.post_volume` only when the guard passes. It withdraws a figure it can no longer support, says nothing when the evidence is incomplete, and fails closed on anything it cannot read. Run it while the cross is live: Jito's public explorer keeps about seven days, and the placement evidence is kept in `stateDir` as it is read. Environment and config: `src/volume-main.ts`, `src/config.ts`. `ATTESTER_DRY_RUN=1` analyses and prints without posting.

**Research notes** (`pnpm start:brief`, ADR-0952). `GET /v1/research/cross/:address` returns a model-written note whose every sentence passed the gate, or the template brief with the reason. Without `ANTHROPIC_API_KEY` it serves the template brief and says so.
