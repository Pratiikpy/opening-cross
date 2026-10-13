# E series, issuer side: treasury creation, rights cards, disclosure updates (2026-10-13)

Outcome: BUILT (E5 posting, the issuer's creation of the X2/A5 treasury, rights cards shown to the issuer). The attester that makes spending possible is HUMAN: the page creates no credential, schema or attestation (a real auditor is the issuer's choice; HUMAN_TASKS HT3, HG3).

## What exists

- `services/api/src/routes/issuer-tx.ts` (new): `POST /v1/tx/create-treasury`, `POST /v1/treasuries/:address/updates/prepare`, `POST /v1/tx/treasury-memo`, `GET /v1/issuer/protocol`. 16 tests in `services/api/test/issuer-tx.test.ts`: the transaction decodes to the program's instruction with the issuer paying, the refusals (supply not fixed, no supply, treasury exists, credential or schema missing or not the attestation service's, junk fields), an update the existing verifier accepts once the authority signs it, and the Memo transaction carrying exactly the text the API checks.
- Web: `/issuer/treasury/new` (`components/issuer/treasury-create.tsx`, `lib/issuer-treasury.ts`, 6 tests), `/issuer/treasury` (the issuer's treasuries with the attestation status and the rights cards the holder sees), `/issuer/disclosures` (`lib/issuer-update.ts`, 9 tests).

## Run on devnet (real transactions, real wallet protocol, a throwaway authority)

`apps/web/e2e/issuer-console.mjs`, Chromium against a local build; the API process served the issuer routes and the existing treasury routes over the live devnet cluster.

- A coin whose mint authority is still set was refused in the form before signing, with the reason and what to wait for.
- A coin with a revoked authority, a quote mint, an allowance of 100, 30 days, 7 days grace, and the credential and schema of the A5 proof (accounts that exist on devnet and belong to the attestation service) enabled Create. Treasuries created: `kCcRgCXmLuSM2Fk3853EWFMszEzroiGMNm8XAmbA546` (first run) and `128MkcfQVJi84X4FWbre8KXhugCQ8baaXtH45c6GgB5W`. The account owner read from chain equals the program the API names.
- The page then showed the rights cards holders will see ("What the program enforces").
- Disclosure update 1 (title, summary, span 2026-10-01 to 2026-10-12, declared spend 0): two wallet prompts (the message, then the Memo transaction). The API listed update 1; on chain the Memo transaction signed by the authority carried exactly `opening-cross/treasury-update/v1 treasury=<address> seq=1 id=<update id>`, and the declared spend (0) matched what the program recorded (0). Repeated for both treasuries.

Screens: `docs/evidence/screens/w2b/console-02-treasury-form.png`, `console-03-treasury-created.png`, `console-04-disclosure.png`.

## Needs the programs workstream

`create-treasury` uses the generated treasury client. The treasury program is being extended (v2: assignment, milestone team tokens); if the instruction's arguments change, this route and its test change with it. E4 (milestone team tokens), E6 (assignment, HT1) and E8 (distributions) have no issuer UI because the instructions do not exist in the deployed program.

## Not covered

A real attester; the attestation lifecycle (renewal, a lapse in the browser); spending from the treasury (the team's `spend` instruction has no issuer UI here); liquidation and redemption screens (holder side).
