# I1 to I3 and I8, issuer parts: explore first, readiness, 390 px (2026-10-13)

Outcome: BUILT for the issuer parts. The embedded wallet (I2) and a KYC step are not built and the page says so.

## What changed

- `/issue` used to show only "Connect the wallet" until a wallet was connected. It now works without one: listing types, token reads, the grid, the guards, the float and value rules, the fees and the simulator all work; a wallet is needed only to check the wallet's own facts and to create. The page says so, and says in the same sentence that creating a cross asks for no identity check, that a gate decides who may bid and does not verify the issuer, and that what an offering needs is a question for the issuer's counsel (honest KYC wording, I1; there is no KYC step).
- Readiness (I3): the seven-item chain checklist is joined by the guard and rule checks (minimum volume reachable, float reachable, value ceiling holds, oracle). Items that need only the form are judged without a wallet; the rest say what they wait for. The "reminder" half of I3 (a notification before the call opens) is not built for issuers: the cross page and `/calendar` carry holder reminders.
- I8 (limits up front, self-custody): "Before you sign" states what is fixed on chain once the cross exists, that the issuer holds the keys, when the bond and proceeds come back, and that a cross that does not print refunds everyone. Withdrawal of proceeds is paid by the program to the wallet named in the cross at finalize; there is no separate withdraw step to make as easy as deposit.
- 390 px coverage gap: the old `/issue` was only shown to a stranger as a prompt at 390. The full wizard was checked at 390 px: no horizontal overflow, and the checklist collapses to a single line so the form is not pushed down (`wizard-05-mobile.png`; `visual/issue-*-390-*.png` and every other issuer page at 390 in light and dark).

## Checks

`e2e/issuer-wizard.mjs` ("390 px: no horizontal overflow"), `e2e/issuer-visual.mjs` (13 pages x light and dark x 1440 and 390: overflow, axe WCAG 2.1 A and AA, console errors; result in the report), `test/issuer-concierge.test.ts`.

## Not covered

- Embedded wallet (email, social, passkey): not built (I2).
- A real person's first-draft time and task success.
- A reminder before a call opens (issuer side).
- Screen-reader walkthrough beyond axe.
