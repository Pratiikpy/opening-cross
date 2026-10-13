# ADR-0318: Signed documents are canonical JSON, hashed, and signed under a domain prefix

Status: accepted (2026-10-13) · Used by ADR-0302, 0304, 0305, 0308, 0313, 0317; the quotes, registrations and intents of ADR-0314 use the same pattern inside `packages/liquidity` · Code `packages/attest`

## Decision

1. **A document is `{ body, id, signer, signature }`.** The body is canonical JSON (an RFC 8785 subset: integers and strings only, so no float can differ between languages), `id` is the sha-256 of that form, and `signature` is Ed25519 by `signer` over `domain + id`.
2. **The domain is the body's own `schema` string and a newline**, and the schema must look like `opening-cross/<name>/v<number>`. A signature made for one kind of document can never verify as another.
3. **Verifying checks four things in order**: the document is well formed, `id` equals the hash of the body, the signer is the expected one when the caller names one, and the signature is valid. A forged body fails at the second step.
4. **A signature proves a key signed, not that the key is trusted.** A reader checks the signer against the key the operator publishes (`/v1/attestations/signer`, `/v1/promises/signer`) or against a rule (the mint authority of the token; the configured backing attesters).
5. **Large numbers are decimal strings** in bodies, so nothing is lost to a 53-bit number.

## Alternatives rejected

- JWS: adds an algorithm field that has to be refused; this has one algorithm.
- Signing a hash of arbitrary bytes: invites cross-protocol reuse; the domain prevents it.

## Consequences

Bodies cannot hold fractions: ratios are basis points or integer-scaled. Key rotation is a publication, not a protocol feature.
