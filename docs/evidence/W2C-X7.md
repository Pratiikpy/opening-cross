# W2C-X7 (with M9): the native app, everything that runs without a device

Outcome: **HUMAN** (H19: run on an Android device or emulator). Everything that can run without one is built and was run on 2026-10-13. Design: ADR-0412.

Added to `apps/mobile`: a claim center on the orders screen (`src/lib/claims.ts`, `src/ui/claim-center.tsx`) that finds every order that can be paid out or refunded (the index lists it open, its cross has settled, the chain still holds the order and gives its nonce) and claims them all in one Mobile Wallet Adapter session; an alerts screen (`src/screens/Alerts.tsx`, `src/lib/alerts.ts`) over `GET /v1/alerts/feed`; and a fix to the crosses list, which labelled every cross the index still called Live as "Open", including ones past their close (`src/lib/listing.ts`: Opens soon, Open, Awaiting settlement, decided by the clock).

Run:

- `pnpm typecheck`: clean (strict).
- `pnpm test`: 34 tests pass (26 before): the claim scan (open orders in settled crosses only, the nonce from the chain, a no-print refund, an unreadable chain reported as unchecked, a failed index reported), the alert helpers (link targets, relative times), the list badges.
- `pnpm export:android`: Metro and Hermes produced `_expo/static/js/android/index-….hbc` (2.9 MB).
- `pnpm export:web`, served and opened in Chromium at 390 in light and dark: the crosses list renders from the live API (screenshots `screens/w2c/mobile-crosses-390-light.png` and `-dark.png`, taken before the list-badge fix, so they still show "Open" on a cross that had closed). One 404 in the console is the browser asking the static test server for `/favicon.ico`.

Honest wording: the README (`apps/mobile/README.md`) states that phone push is not in this build (Firebase credential and a development build: HH6), that the passkey wallet is a web feature, that the web export cannot show the wallet-dependent screens (the wallet module is Android-only), and that nothing has run on a device.

Not covered: any run on Android (the wallet round trip, the development build, on-device layout, the claim center signing two transactions in one session), the Seeker build, iOS, an embedded wallet and an onramp in the app, local or push notifications.
