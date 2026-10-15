# ADR-0901: Cleanverse client

Date: 2026-10-16 · Status: accepted · Ports `packages/cleanverse` from commit `8f753df` (ADR-0155 there) · Row G4

## Decision

`packages/cleanverse` is a typed client of the Cleanverse cooperate API, written against `Downloads/cleanverse.md` v5.6 and checked against it field by field this session. It covers `generate_apass`, `update_status`, `query_apass`, `query_apass_list`, `verify_apass`, `query_deposit_atoken_list`, `faucet` and the four validator reads (`is_register`, `rules`, `verify`, `is_paused`).

- **Auth.** Every request carries the `api-id` header (reference "Authentication"). The api-key is the AES key only and is never sent. A global note in the maintainer's instructions says `appId` and `apiKey` headers; the reference says `api-id` and the client follows the reference. NOT VERIFIED against the live sandbox (no credentials on this machine, HI1).
- **Encryption.** AES/CBC/PKCS5, zero IV, key = Base64-decoded api-key, body `{"data": "<Base64>"}`; vectors checked against OpenSSL in tests.
- **Errors.** HTTP 400, 403, 404, 409, 5xx and envelope codes `0001`, `0002`, `1000`, `12026`, `12027` are distinct classes; an unknown code is an error. 5xx and timeouts are retried for reads; writes are attempted once.
- **Responses** are validated field by field; a malformed body is `MalformedResponseError`, never a default.
- **Countries.** The 194 alpha-2 codes are the reference appendix (compared programmatically: identical) mapped to ISO numeric through the gate client's table.
- **Identity id.** `deriveIdentityId` (HMAC-SHA256 of `provider:customerId` keyed by the attester secret) lives here, on `node:crypto`, so the gate client stays free of hashing dependencies.

## Not verified

What text the sandbox returns for a wallet with no A-Pass, what the tier numbers mean, whether `customerId` is a stable per-person key, and whether `currentKycHash` is per person. The provider takes these as options (`notFoundPattern`, `identityKey`) and the attester refuses rather than guesses when they do not hold. Run `pnpm --filter @opening-cross/cleanverse sandbox:smoke` once the credentials file exists.
