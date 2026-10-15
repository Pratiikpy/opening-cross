# @opening-cross/identity-attester

Two attesters for `cross_gate`.

**The devnet test attester** (`pnpm start`, `pnpm init`) signs a Solana Attestation Service attestation for a wallet that proves it controls the wallet. It verifies no identity.

**The KYC attester** (`pnpm kyc <command>`) turns "this wallet's holder passed KYC at a provider" into the wallet's `oc-identity` attestation, which `cross_gate` reads in `claim_pass_attested`; keeps those attestations true; and closes them when the provider stops vouching so anyone can revoke the pass.

```
pnpm kyc init                 create the SAS credential and the identity and accreditation schemas (idempotent)
pnpm kyc attest <wallet>      ask the provider and attest, or say exactly why not (exit 0 / 3 ineligible / 4 provider down)
pnpm kyc status <wallet>      the attestation as it is on chain
pnpm kyc sync                 re-ask the provider about every attestation: close, refresh, or leave
pnpm kyc serve                HTTP API and the sync loop
```

Providers: Cleanverse (`src/cleanverse-provider.ts`) and a manual allowlist file (`src/allowlist-provider.ts`), both behind `KycProvider`. Design: `docs/adr/0902-identity-attester.md`. Operating it: `RUNBOOK.md`.

Tests: `pnpm test` (decision rules, the Cleanverse provider against a local contract server, the HTTP API including wallet-signed requests, the allowlist, the test attester). Through the real SAS binary and `cross_gate`: `packages/cross-gate-client/test/svm` (LiteSVM) and `apps/web/src/app/gates/_e2e/gate-rules-flow.mjs` (local validator, browser, this service running).
