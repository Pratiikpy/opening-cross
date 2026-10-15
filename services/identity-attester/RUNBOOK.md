# Running the KYC attester

Steps that need a person are marked HUMAN with the task id in `docs/HUMAN_TASKS.md`.

## Keys (HUMAN, HI2)

On the host that runs the service, outside the repository, mode 600:

- `ATTESTER_KEYPAIR`: a Solana keypair file (`solana-keygen new -o`). It is the SAS credential authority. Fund it with a little SOL: about 0.003 per credential or schema and 0.0027 per attestation, returned when an attestation is closed.
- `ATTESTER_SECRET_FILE`: 32 or more random bytes as hex. It derives every identity id and the wallet challenge key. It cannot be recovered: losing it changes every identity id, so back it up offline.

## Configuration

| Variable | Meaning |
|---|---|
| `RPC_URL` | cluster endpoint (required) |
| `ATTESTER_PROVIDER` | `cleanverse` (default) or `allowlist` with `ATTESTER_ALLOWLIST_FILE` |
| `ATTESTER_CREDENTIAL_NAME` | SAS credential name, default `oc-attester` |
| `ATTESTER_TIER_RETAIL_MIN`, `ATTESTER_TIER_ACCREDITED_MIN`, `ATTESTER_TIER_QUALIFIED_MIN` | provider tier thresholds (HI3: what Cleanverse tiers mean is unknown, so accredited and qualified are off until set) |
| `ATTESTER_COUNTRY_PRIORITY` | comma list that resolves a record with several countries |
| `ATTESTER_REQUIRE_COUNTRY` | default true |
| `ATTESTER_ASSERT_SANCTIONS_SCREENED` | operator assertion that the provider screens (HI3) |
| `ATTESTER_MAX_TTL_SECS`, `ATTESTER_MIN_REMAINING_SECS`, `ATTESTER_DEFAULT_CAP_ATOMS` | attestation lifetime and cap policy |
| `ATTESTER_CLEANVERSE_IDENTITY_KEY` | `customerId` (default), `kycHash` or `cvRecordId`; changing it changes every identity |
| `ATTESTER_CLEANVERSE_NOT_FOUND_PATTERN` | regex for the sandbox's "no A-Pass" text once observed (HI1) |
| `ATTESTER_API_TOKEN` | 24+ characters; the operator's API presents it to ask for any wallet |
| `ATTESTER_WALLET_SIGNED=1` | let a wallet ask for its own attestation with a signature (the web app does) |
| `ATTESTER_CORS_ORIGIN` | the web app's origin |
| `ATTESTER_SYNC_INTERVAL_SECS` | revocation sweep, default 900 (0 turns it off) |
| `HOST`, `PORT` | bind address (default 127.0.0.1:8787); a non-loopback host needs a token or wallet-signed mode |

Cleanverse credentials: `appId` and `apiKey` in `~/cleanverse/.secrets/cleanverse.env` (HI1). The web app reads the attester at `NEXT_PUBLIC_KYC_ATTESTER_URL`.

## First run

1. `pnpm kyc init` prints the credential and schema addresses. Give them to each issuer: they go in the gate's rules (`/gates/<mint>`, "Attesters and passes").
2. `pnpm kyc attest <a test wallet>`; then `pnpm kyc status <wallet>`.
3. `pnpm kyc serve`.

## What to watch

A provider outage returns `provider_unavailable` (HTTP 503) and changes nothing. A wallet the provider no longer vouches for has its attestation closed at the next `sync` (or `attest`); after that anyone can close its pass with `revoke_expired`. Logs hold wallet addresses and outcome codes only.
