# ADR-0308: Presets are signed documents, attributed by a memo in the creation transaction

Status: accepted (2026-10-13) · Rows L2, X15 · Code `packages/preset-registry`, `services/api/src/routes/presets.ts` · Evidence `W2A-L2-presets.md`

## Decision

1. **A preset is an author-signed, versioned document** of create-cross fields only. It never sets a price, supply or raise. It is valid only if the program would accept its fields (for example levels 2 to 256; a sealed call has a reveal window and an open one has none; a minting preset is a launch or recurring cross). A published version is never changed; a new version must be higher.
2. **A cross is attributed to a preset by a memo in its creation transaction** (`oc-preset:1:<author>/<id>@<version>`). Attribution is therefore on chain without a program change, cannot be claimed by someone who did not use the preset, and is read once per cross.
3. **Performance counts only memo-carrying crosses**, with the number behind every figure, a Wilson interval on the print rate, no headline below a minimum sample, and a count of crosses whose bidders were all the issuer's own wallets.
4. **A royalty is a declared claim, capped at 1000 bps, and nothing pays it.** Paying an author needs fee sharing in a program (Meteora's `fee_claimer` / Dynamic Fee Sharing is the intended route), a deploy decision and an audit scope.
5. **Not a ranking.** Responses say outcomes are partly the tokens' and that no causal claim is made.

## Alternatives rejected

- Recording the preset id in the cross account: a program change for a label.
- Attribution by matching field values: any cross with the same values would count; an author could not be sure a cross used their preset, and gaming is trivial.
- Paying royalties from the API's fee wallet: an unenforceable promise presented as a feature.

## Consequences

The issuer wizard must add the memo for a cross to count; the `use` endpoint returns it.
