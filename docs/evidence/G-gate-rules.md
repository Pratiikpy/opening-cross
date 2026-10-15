# G-gate-rules: gate compliance rules, Cleanverse client, identity attester, gate screens

Run 2026-10-16. Rows G4, G5, G2/V6. Design: ADR-0900 to ADR-0903.

## What was proved

| Layer | Evidence | Result |
|---|---|---|
| Program unit tests (`cargo test -p cross_gate`, WSL) | country lists, tier and flags, rule validation, extension round trip, 44-byte identity record, terms leaf, SAS payload reader | 11 passed |
| Program lints (`cargo clippy --all-targets`) | | no warnings |
| Program on LiteSVM, real SAS binary (`pnpm --filter @opening-cross/cross-gate-client test:svm`, WSL) | `test/svm/gate-rules.test.ts` 17 tests: opt-in once and only by the authority, legacy paths closed, every refusal (country allow and deny, unknown country, tier, flags, expired or foreign attestation, forged identity, holder cap, issuance window, one pass per identity, denial), separate accreditation attester, terms allowlist, authority grants bound by the rules, every way a pass ends (expiry, attestation closed, rules tightened, denial, block in one transaction), refresh, diagnosis agrees with the program. `test/svm/gate-hook.test.ts` 8 tests on a real Token-2022 transfer hook: receiver needs a pass, insider blackout and rolling volume limit, receiver's lapsed terms and rule changes stop a transfer, `open_volume`, the short list stays until the authority rewrites it, upgrade from the pre-rules binary, lock delegate never weakens, `receive_locked` and allocation hooks refuse every imitation of a cross | 25 passed |
| Existing `tests/core` suite against the new binary (`OC_DEPLOY_DIR`, WSL) | see "Existing suite" | 526 passed, 3 failed (none caused by the program change except the OCIP seed table, which needs the spec update) |
| Client unit tests | 24 (identity vector, discriminators, countries, rules region size, `conform`, hook accounts and list version, resale locks, plain-English rules, presets, web copy is current) | passed |
| `packages/cleanverse` | 46 (AES vectors, HTTP contract against a local stub, strict responses, credentials, countries) | passed |
| `services/identity-attester` | 62 (decision rules, Cleanverse provider, allowlist provider, HTTP API, wallet-signed requests, the devnet test attester) | passed |
| `packages/presets` | 27 (existing; terms-allowlist leaf is checked through the program in `gate-rules.test.ts`) | passed |
| Web gate form and text logic | 16 (`apps/web/src/app/gates/_lib/form.test.ts`) | passed |
| Typecheck | client, cleanverse, attester, presets, `apps/web` | clean |
| Browser, local validator, real transactions (`apps/web/src/app/gates/_e2e/gate-rules-flow.mjs`) | an issuer creates a gate for a token and switches Regulation S rules on; three people with different standings at the issuer's identity provider (manual allowlist) ask for a pass through the running KYC attester, signing in a wallet; the issuer grants an insider a pass and blocks a wallet. Every page claim is read back from the chain. Light and dark, 1440 and 390 px, no overflow, axe clean, no console errors | 45 passed, 0 failed |

Local validator proof, mint `CSrpdshhddxCPvCoiMF1q1KUJ7ypwSWXjrUrHwYpufKd`, SAS credential `5b3gaDEBnRv2fvdySSmTVmEkP94Ecqp1GciaQidQqYed`, identity schema `9pCTy6rsNjgXPhhMMiDT5MmHj99rkFBtUTL2u7rDpY34` (throwaway keys, the cluster is gone):

| Step | Signature |
|---|---|
| create gate | `c26XvQ41C2fVKQCnGoCX9bB2qCVKACiasxyWMThEsMP5yDPA3HNruskR9hvioYjEQcboTjSLCPJBjeBERx6gfiU` |
| rules on (config 172 to 653 bytes) | `jXGkUtXCPM4dFDK9Sqt3EJjnuSwhNqr2XdB5ai5aohJ6hgxCJKShnQBSAoxrkY9Mkq6vWpdPS2GBSidS9RtmLpc` |
| Alice (India) claims | `3xk1M8G3wmxWDvQBJN4tLnZ4hqhn8YdNj7piXWAKC3Ta2S1vGgmCNKEXkxbuKZAjCjFPyZbKXfx8eSbuFfoSjJFU` |
| grant insider | `5c2Xzut1W6t7rh8TgaN96S1AXRjJhi4qyiRRTWiLNZzibJioSsLhRKZnG6mCgPzPhjxqADvrqQPdb3zuJD724Eo5` |
| block Alice (deny and close pass, one transaction) | `4m29AJmy4dYTZ2J7WbYMa9GRb8XE1qofmQMr5V34pH5HQAqdLoPxDbjVcSknDqctJmdcFkvkfhCJitd4yTK2d6gF` |

Bob (verified, in the United States) was recorded truthfully by the attester and refused by the gate with his country named; Carol (unknown to the provider) was told the provider has no record of her wallet and nothing was written. A grant that violated the rules was refused by the program and the page showed its message.

Screenshots (quantized): `docs/evidence/G-gate-screens/`.

Compute units, single-instruction transactions on LiteSVM (max of n): `claim_pass_attested` 44,025 (17), `grant_pass_terms` 41,170 (13), `claim_pass_merkle_terms` 37,650 (3), `revoke_expired` 27,574, `revoke_nonconforming` 20,047, `revoke_pass_terms` 16,959, `revoke_denied` 16,634, `open_volume` 12,780, `reserve_allocation` 12,592, `update_hook_metas` 11,674, `receive_locked` 10,534, `set_lock` 9,970, `deny_wallet` 9,578, `refresh_terms` 8,731, `init_rules` 7,866, `set_rules` 6,183, `release_allocation` 3,564, `allow_wallet` 3,105. The hook `execute` was not measured separately.

Program size 667,064 bytes (sha256 `76bf9119da252d424f497849bc46a84bc2cd51f7717290b0e06d453c5183a604`) against 364,032 deployed.

## Found by testing, fixed

- The branch's longer hook list broke every existing hooked-mint client (10 failures in the first full run); the list is now opt-in per gate.
- The branch read `gate_mint` from a fixed byte offset that is wrong whenever an earlier `Option` is `None`; found against a real cross.
- An affiliate who became one after issuance could never transfer (`open_volume`).
- `diagnoseEligibility` named no previous holder for a claim that needs one.
- The browser flow caught three states where a success message vanished because the page moved to the next step, and a verify step that lingered after the chain moved on.

## Existing suite

`tests/core` (79 files) against the final binary: 526 tests passed, 15 skipped, 3 failed. The three: `graduate.test.ts` (fails identically with the unmodified binary), `ocip-spec.test.ts` seeds (the spec update below), and `settle-batch.test.ts`, a 5 s timeout while 70 workers shared the machine; it passes alone with the new binary (4 of 4) and with the old one.

Known failures that are not from this change: `graduate.test.ts` "an outcome for another venue..." fails identically with the unmodified binary (`MissingTokenAmountAsTokenLaunchProof` from the DLMM fixture). `ocip-spec.test.ts` "PDA seed constants equal the program sources" fails because the spec has not been updated for the new seeds (outside this package's ownership).

## Not covered / NOT VERIFIED

- Devnet: the deployed program is the old binary; the upgrade needs about 303 KB of rent and a funded buffer (HG5). Nothing here ran on devnet.
- A real KYC provider: no Cleanverse credentials exist on this machine (HI1), so `sandbox:smoke` and the not-found text, tier meanings, the identity key and the `api-id` header against the live sandbox are NOT VERIFIED. The manual allowlist provider ran end to end.
- Legal content of the presets (ADR-0903): not re-read against primary sources.
- Real wallets: the browser run used the repository's Wallet Standard test wallet, not Phantom or Solflare.
- A hooked mint driven through a DBC curve or graduated to DAMM v2 with rules on; `cross_core` calling `receive_locked` and `reserve_allocation`; the Token ACL path under rules.
- The Cleanverse A-Pass lifecycle (`generate_apass`, `update_status`, faucet) against the sandbox.
- The old `/gates` list (`GatesView`) was present but its API (port 8080) was not running in the browser run.
- Mobile Safari, Firefox; screen readers beyond axe.
