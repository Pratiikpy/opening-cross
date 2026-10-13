# Opening Bell for Android

The native app: browse crosses, read the book, the signed price band and the token identity check, place and cancel orders, reveal sealed bids, settle, and claim. The orders screen carries a claim center that finds every order that can be paid out or refunded and claims them all in one wallet session; an alerts screen lists what needs you now (orders to claim, crosses about to close on your orders). Transactions are built by the Opening Cross API, **signed by any wallet that speaks the Mobile Wallet Adapter**, and sent by the app. The app holds no key.

Expo SDK 57 (React Native 0.86, React 19.2), `@react-navigation/native-stack`, `@solana-mobile/mobile-wallet-adapter-protocol` 3.x. It is a standalone project (its own lockfile, excluded from the repository's pnpm workspace).

## Run it

```sh
cd apps/mobile
pnpm install --ignore-workspace
# Expo Go cannot load the wallet module; this needs a development build on an Android device or emulator.
EXPO_PUBLIC_API_URL=http://10.0.2.2:8080 EXPO_PUBLIC_RPC_URL=http://10.0.2.2:8899 EXPO_PUBLIC_NETWORK=devnet pnpm android
```

`10.0.2.2` is how an Android emulator reaches the host machine. Point `EXPO_PUBLIC_API_URL` at your API (`services/api`) and `EXPO_PUBLIC_RPC_URL` at the cluster it follows. Install a Mobile Wallet Adapter wallet on the device first.

## Checks that run without a device

```sh
pnpm typecheck        # strict TypeScript
pnpm test             # 34 unit tests: units, base58 and base64, wallet account decoding, request building, order entry, sealed-bid storage, the claim scan, the alert feed, the list badges
pnpm export:web       # Metro bundles the app for the web
pnpm export:android   # Metro + Hermes compile the Android bundle (2.9 MB Hermes bytecode on 2026-10-13)
```

## How a transaction is signed

1. `POST /v1/tx/place-order` (or cancel, reveal, settle, claim) returns an unsigned base64 transaction.
2. `transact(async (wallet) => …)` opens a wallet session. Inside it: `wallet.authorize({ identity, chain: 'solana:devnet', auth_token? })`, then `wallet.signTransactions({ payloads })`. A stored `auth_token` reauthorizes silently; one the wallet rejects is discarded and the wallet is asked afresh.
3. The app sends the signed transaction with `sendTransaction` and polls `getSignatureStatuses` until it is confirmed, reporting the program's own error text on refusal.

Sealed bids keep their price, quantity and salt in AsyncStorage on the device (and a shareable backup); an order is not sent unless that record was stored first.

## Not verified here

Push notifications to the phone are not in this build: they need a Firebase project and a development build (docs/HUMAN_TASKS.md HH6). The alerts screen is read when it is opened. The embedded and passkey wallets of the web app are not in the native app, which signs with a Mobile Wallet Adapter wallet only.

The web export of this app (`pnpm export:web`, served and looked at in Chromium at 390 pixels, light and dark) renders the crosses list from the live API; the wallet module is Android-only, so the screens that need a connected wallet were not looked at.


Nothing in this folder has been run on an Android device or emulator: the wallet round trip, the development build, and the screens' on-device layout are open. See `docs/HUMAN_TASKS.md` H19 for the exact steps and ADR-0020 for what is covered.
