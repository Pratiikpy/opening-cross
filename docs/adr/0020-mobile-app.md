# ADR-0020: Native mobile app (Expo, Mobile Wallet Adapter)

Status: accepted (2026-10-11); the on-device run is open (HUMAN H19)

## Context

ROADMAP MO2 asks for a native app that can place and claim on devnet from Android. Solana wallets on Android sign for other apps through the Mobile Wallet Adapter (MWA): the app opens a session with the wallet, the wallet asks its user, and a signed transaction comes back. The API already returns an unsigned transaction for every action, so the app never needs a key.

Alternatives considered:

| Option | Why not |
|---|---|
| Mobile web only (done, MO1) | No wallet session on Android browsers without a wallet's in-app browser; it stays as the fallback |
| Native Kotlin | Duplicates every screen and the unit logic the web app already has |
| React Native CLI | Expo gives the same native modules with prebuild, one config and web export for CI checks |
| Wallet Standard / web3.js stack in React Native | Needs polyfills and a second serialisation path; the API already hands over base64 transactions, which MWA signs as-is |
| Expo with the base MWA protocol package, no web3.js | Chosen |

## Decision

`apps/mobile`, Expo SDK 57, a standalone project (own lockfile; excluded from the root pnpm workspace so CI's frozen lockfile and `pnpm -r` are unaffected).

- **Signing** follows the MWA specification and the installed package's types (read, not recalled): inside `transact`, `authorize({ identity, chain: 'solana:devnet' | 'solana:mainnet' | 'solana:testnet', auth_token? })` then `signTransactions({ payloads })` with the API's base64 transactions. Sessions are stateful since spec 0.3, so no token is passed to signing. A stored `auth_token` reauthorizes silently; `ERROR_AUTHORIZATION_FAILED` discards it and asks again once. `deauthorize` runs on disconnect. The wallet's account address (base64) is converted to base58 by code tested against an independent decoder. MWA is loaded lazily and only on Android; elsewhere the app says so.
- **Sending** is the web app's path, ported: `sendTransaction` with `preflightCommitment: confirmed`, polling statuses to a 90 s deadline, the program's own error text on refusal, "you declined" on a wallet rejection, and a refusal if the wallet returns a different count of transactions or something that is not base64.
- **Screens:** crosses list; cross detail (price, book, signed band with calibration reasons as sentences, token identity panel, premium monitor link, order ticket, settle, your orders with cancel, reveal and claim); your orders across crosses; premium monitor. The web app's pure libraries (units, premium formatting, calibration reasons, trust types) are copied, so both clients format identically.
- **Sealed bids:** price, quantity and salt are written to AsyncStorage before the order is sent, and the order is refused if that write fails; a backup is shareable. The salt and nonce come from `expo-crypto`.
- **Design:** the tokens of `apps/web/src/app/globals.css` in light and dark, Hanken Grotesk and IBM Plex Mono.

## Verified without a device

`tsc --noEmit` (strict); 26 unit tests (units; base58 and base64 against Node and an independent decoder; account decoding in both wallet shapes; chain identifiers; the API build call; the sign, send and confirm loop with scripted RPC responses, covering decline, wrong count, junk, program refusal, on-chain failure and timeout; price grid validation, escrow rounding, request bodies, phases; sealed storage including a failed write; order views); `expo export --platform web` and `expo export --platform android` (Metro and Hermes compile 984 modules to a bytecode bundle); `expo prebuild --platform android` generates the native project.

## Not verified (open)

No Android device or emulator was available in this session. Unrun: the development build, native autolinking of the MWA module by Gradle, the wallet round trip (association intent, authorize, sign, return), on-device layout and keyboard behaviour, and a full devnet place, settle and claim. Expo Go cannot load the MWA native module, so a development build is required. These are the steps in HUMAN H19.

## Consequences

- The app depends on a reachable API; it shows that plainly rather than a number.
- The identity check is mainnet-only by design (ADR-0016); on devnet the panel says so.
- The web and mobile copies of the pure libraries can drift; a shared package is the fix when a third client appears.
