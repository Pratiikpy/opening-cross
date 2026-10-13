# ADR-0354: Treasury creation and disclosure updates are built by the API and signed in the wallet

Status: accepted (2026-10-13)

## Context

The treasury program, its read API and the disclosure feed exist (ADR-0014). Creating a treasury and posting an update needed a command line and a keypair file. An issuer should do both from the console with a browser wallet, and be told before signing what the program would refuse.

## Decision

- `routes/issuer-tx.ts` adds `POST /v1/tx/create-treasury`. It checks what the program would check, and more, before building: the coin is a mint of a token program, its mint authority is revoked (otherwise `SUPPLY_NOT_FIXED`, with the instruction to wait for the cross to finalize), it has a supply, the treasury does not exist, and the credential and schema accounts exist and belong to the Solana Attestation Service. The transaction comes back unsigned with the authority as fee payer.
- Posting an update is four steps: `POST /v1/treasuries/:address/updates/prepare` builds the update body (sequence and previous id from the stored chain of updates, the time from the server), the wallet signs the message, `POST /v1/tx/treasury-memo` builds the Memo transaction that anchors the update's id and the wallet signs and sends it, and the signed update and the anchor's signature go to the existing `POST /v1/treasuries/:address/updates`, which verifies everything against the chain. The browser orchestration (`lib/issuer-update.ts`) stops at the first failure and says which step failed and whether an anchor already landed.
- The page never creates an attestation credential, schema or attestation. The attester the issuer names does, and the form says so. Which attester is trustworthy is the issuer's and its holders' judgement.
- The rights cards holders see are shown to the issuer, from the same API read the holder page uses, so the issuer reads what the program does and does not promise.

## Consequences

- `create-treasury` uses the generated treasury client (`getCreateTreasuryInstructionAsync`). If the programs workstream changes the instruction's arguments (the treasury program is being extended), the route and its test change with it.
- Two wallet prompts per update (a message and a transaction). A wallet that cannot sign messages gets an explanation instead of a crash.
- The update path was run on devnet with a real treasury, and the anchor read back from the chain (`docs/evidence/W2B-E-series.md`).
