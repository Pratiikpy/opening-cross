# ADR-0302: Integrity analysis states bounds and evidence, never a verdict

Status: accepted (2026-10-13) · Rows F2, F3, F6, F8, F9, J3, V5 · Code `packages/integrity`, `services/api/src/routes/integrity.ts` · Evidence `W2A-F-integrity.md`

## Decision

1. **Every label, flag and finding carries the fact that justifies it.** A holder is "protocol" because its owner is a pool authority constant taken from that protocol's IDL, or because the owner's account is owned by a named program; "issuer" because it is the mint authority or created a cross selling the token; "team" because the issuer signed a document saying so. A label without a basis is not produced; an unlabelled address is called a wallet, not a proven individual.
2. **Funding is traced to the first SOL a wallet received.** Two wallets with the same first funder, or one funded by the other, are linked as evidence of common control, never as the same person. A funder that has funded many wallets (25 or more across everything traced, or listed by the operator) is a service, is not a link, and is reported as ignored.
3. **The organic-volume score (F2, version 0, experimental) is a pair of bounds, not a number.** Lower: volume from bidders shown independent. Upper: volume not shown inorganic. Volume nothing shows either way is reported between them. Untraced wallets and wallets funded by a service sit between the bounds; they are never counted as independent.
4. **Signed documents carry the issuer's side.** A supply declaration, a team list and a backing attestation are Ed25519 documents (ADR-0318). Supply and team documents are accepted only from a key tied to the token (its mint authority or the creator of a cross selling it); a backing attestation only from a signer the operator trusts (`BACKING_ATTESTERS`, empty by default).
5. **The rating (V5) is a published formula with unfitted weights, and its track record is part of the product.** The track record states the hit rate against the base rate, a rank correlation with a seeded permutation p-value, and says "does not beat chance" when that is the result and "insufficient sample" below 20 outcomes. No accuracy or AUC is claimed anywhere else.
6. **The brief (J3) is templates filled with cited facts; claims are checked against the same facts.** Supported, contradicted, or unverifiable (the fact is missing). Sentences the checker cannot read are returned as unparsed, never waved through. No language model is involved.

## Why bounds, not a score

First-funder tracing cannot show a wallet is independent or manipulative; it can show ties. A point estimate would invent precision. The lower bound is the conservative reading and the one a gate should use.

## Alternatives rejected

- A single "manipulation probability": unfalsifiable without labelled wash data, which does not exist here.
- Treating every shared funder as a link: an exchange or faucet would cluster the whole population (it did, on devnet, in the first run).
- A generated narrative with an LLM: numbers the model writes are not facts. A fluent version needs a key and a verifier that already exists here (HUMAN_TASKS).

## Consequences

Per-asset auto-pause for unverified backing needs a program change; the monitor reports a warning instead (ADR-0311). The Jito bundle input to F2 is not integrated.
