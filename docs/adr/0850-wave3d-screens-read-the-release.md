# ADR-0850: The Wave 3D screens read the release, and offer nothing the cluster would refuse

Status: accepted (2026-10-15) · Builds on ADR-0800

## Context

The seven programs of Wave 3D (`cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing`, `cross_graduate`) and the batch 2 instructions of `cross_settle` (`open_fixed_price_presale`, `seed_futarchy_dao`) are proved on LiteSVM and a local validator and are not deployed to devnet until the operations key is funded (H27, H43). A screen that offers them as if they were live would be a false claim, and a screen that hides them would leave the work unseen.

## Decision

- **One source.** Every screen asks `GET /v1/programs` (`apps/web/src/lib/new-programs.ts`) for the `features` it needs. `available: true` is live, `false` is "built, not on this network yet", `null` is "could not be checked". An unreadable program is never turned into a missing one.
- **One notice.** `FeatureNotice` says which of the three it found, in the same words on every page: live on the network; or "Built, not on devnet yet", with the API's own note and the funding step; or "Release not confirmed", with the fact that each action is simulated first.
- **One button.** `FeatureAction` wraps the issuer action (build through the API, simulate on the cluster, sign, send, confirm). While a feature is definitely not on the network the button is off and says why; with the release unknown it stays on, because the dry run refuses what the program would.
- **Reads that cannot 404.** A page for one venue, bounty, mandate or basket asks the index first. A network without the program, or an address the index does not hold, is said in words; the browser never logs a 404 for a page that handles it. The index lags the chain by the indexer's delay, so a record created a moment ago can be absent from it: the page says "no ... is known", not "does not exist".
- **Honest limits on the page.** Each screen repeats what its ADR says the program does not do: a bond is not the buyers' compensation (ADR-0653); eleven invariants are not a proof (ADR-0654); a statement is a claim, not an audit (ADR-0655); a vote counts locked tokens, never a price, and the quorum can be diluted while the issuer holds a mint authority (ADR-0656); a mandate bounds an agent's worst case, it does not improve its judgement (ADR-0650); a basket's vault can be frozen by a component's issuer (ADR-0652); a lock has no exit (ADR-0651).

## Not decided here

The index lag on a record created a moment ago is accepted. Reveal of a sealed mandate order has no screen (the MCP draft exists).
