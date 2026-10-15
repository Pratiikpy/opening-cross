# ADR-0902: Identity attester

Date: 2026-10-16 · Status: accepted · Ports `services/identity-attester` from commit `8f753df` (ADR-0154 there) · Rows G4, G5

## Decision

The service now has two attesters that coexist. The devnet test attester (wallet-control challenge, `src/main.ts`, `chain.ts`, `challenge.ts`) is unchanged because `apps/web/src/lib/gate.ts` and `tests/devnet` use it. The KYC attester (`src/kyc-*.ts`, `attester.ts`, `decision.ts`, `sas.ts`) turns what an identity provider says about a wallet into the `oc-identity` attestation `cross_gate` reads, keeps it true, and closes it when the provider stops vouching.

- **Providers** implement `KycProvider`: Cleanverse (A-Pass) and a manual allowlist file. An unanswered question never creates or removes an attestation (`provider_unavailable`); an answered "no" closes it, so anyone can then revoke the pass.
- **Decision** is pure: provider tier to attested tier by thresholds, one country (a priority list resolves several tags; none or ambiguous is refused), expiry never beyond the provider's, flags from what the provider states plus operator assertions.
- **Who may ask.** Recording a verification publishes country and tier on chain, so only the wallet itself or the operator's API may ask. Added over the branch: `GET /v1/identity/challenge` and a wallet-signed `POST /v1/identity/attest` (Ed25519 over an HMAC-bound text, ten-minute window, key derived from the attester secret), so the holder's browser can call the attester directly. A refused request does not consume the wallet's lookup cooldown.
- **Replace, never gap.** `upsert` closes and recreates in one transaction.
- The service keeps no personal data and logs wallets and outcome codes only.

## Not verified

Everything against a real KYC provider (HI1, HI3). The real SAS binary and `cross_gate` are exercised by the LiteSVM suite and by `apps/web/src/app/gates/_e2e/gate-rules-flow.mjs` on a local validator.
