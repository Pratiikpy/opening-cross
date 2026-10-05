# ADR-0012: Identity gating with SAS attestations and Merkle allowlists

Date: 2026-10-05 · Status: accepted · Builds on ADR-0004 · Implements PRD [W3, B7, G7]

## Decision
A `cross_gate` pass remains the single eligibility record (ADR-0004). Passes can now be obtained three ways:
1. **Granted** by the gate authority (unchanged).
2. **SAS attestation** — the gate stores one Solana Attestation Service credential and schema. Anyone may submit a wallet's attestation; `claim_pass` accepts it only if it is the SAS PDA `["attestation", credential, schema, wallet]`, is owned by SAS, carries discriminator 2, and has not expired (`expiry = 0` never expires). Layout and discriminator come from the SAS source (`program/src/state/attestation.rs`, MIT), not from the generated client, whose enum order differs. When the attestation expires or the issuer closes it, `revoke_unattested` lets anyone close the pass; the rent returns to the pass owner.
3. **Merkle allowlist** — the authority publishes a root; `claim_pass_merkle` accepts a sorted-pair SHA-256 proof for the leaf `sha256(0x00 ‖ mint ‖ wallet)`. Leaves and inner nodes are domain-separated (`0x00` / `0x01`) so an inner node can never pass as a leaf. `@opening-cross/sdk` `buildAllowlist` produces the root and proofs.

## Evidence
`tests/core/test/sas.test.ts` against the mainnet SAS binary, with credential, schema and attestations created by SAS's own instructions: an attested wallet claims a pass and can order in a gated cross; a wallet without an attestation, or presenting another wallet's, is refused; expiry and issuer closure both let a stranger revoke. Allowlist: five listed wallets claim with proofs; an outsider with a borrowed or empty proof is refused.

## Consequences
KYC providers integrate by issuing SAS attestations; Opening Cross never holds identity data. Choosing which SAS issuers to trust for a given asset is a compliance decision (HUMAN_TASKS H2).
