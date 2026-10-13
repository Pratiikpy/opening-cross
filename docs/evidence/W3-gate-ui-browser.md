# Browser run: the gate screens (W3, G6, G4, G1, issuer gate field)

Script `apps/web/e2e/gate-flow.mjs`, Chromium, a disposable wallet (`apps/web/e2e/gate-wallet.js`: the Wallet Standard test wallet plus `solana:signMessage`), the gate routes served by `apps/web/e2e/gate-harness.ts` against devnet (the other `/v1` calls forwarded to the live API), and the devnet test attester started from key files. Gate `DrW3Pxx2…` and cross `5LgCTQic…` come from `docs/evidence/W3-gate-claim-devnet.md`'s run family.

Observed in the full run (light and dark, 1440 and 390):
- `/gates`: no horizontal overflow and axe clean at 1440 light, 1440 dark, 390 light, 390 dark. The page lists the gates found on recent crosses with their routes, allowlist root, credential, schema and authority.
- A connected wallet with no pass is shown "You do not hold a pass", the rule that blocks it and what would satisfy it, and the "Get a devnet test attestation" button.
- Eligibility card (hosted on a temporary preview route, since removed): refused with the diagnostic, axe clean; the wallet signed the attester challenge in the wallet, the card changed to "You can claim a pass"; the wallet signed the API-built claim transaction; the card said "may place an order"; the pass account `6Qh2LEZc…` was read from chain, owned by cross_gate. Axe clean at 390 light.
- Gate field: root, wallet count, repeated entry and invalid entry shown; publishing a list that is not the gate's on-chain list refused with the reason; axe clean at all four combinations of theme and width.

Not covered: the eligibility card at 390 dark and 1440 dark (the run was cut by devnet RPC rate limiting on the harness and not repeated; its code path is the same component), the card and field mounted inside the real order ticket and issuer console (another agent owns those folders), an order placed from the browser (the order is proved by script in W3-gate-claim-devnet.md), a hardware or real wallet, the console-error check on the full run (the last full run aborted on a 503 from the rate-limited RPC before it; the field-only run reported only the deliberate 400 for publishing an invalid list).
