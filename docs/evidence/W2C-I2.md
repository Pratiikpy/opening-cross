# W2C-I2 (with I1, I3): explore first, an embedded wallet, readiness

Outcomes: **I1 BUILT** (browsing needs no wallet and no identity step until an order is placed in a gated cross: the eligibility panel at the order ticket, verified in the earlier gate runs), **I3 BUILT** (readiness checklist and reminder), **I2 HUMAN**: the passkey wallet is built and verified; email and social sign-in need a wallet provider's account (HH4).

## Readiness checklist (I3)

`components/cross/holder-readiness.tsx`, shown on an upcoming or open cross for a connected wallet: wallet connected, SOL for the fee (or that the sponsor can cover it), the quote-token balance read from the chain, a gate pass where the cross has one, the risks read once, each with what to do, plus Follow for a reminder. Run on devnet with the wallet that has no SOL (W2C-I6.md): the checklist reported the missing SOL with the sponsor as the way through, then the real balance of the quote token. Screenshot read: `screens/w2c/final-window-coarse-1440-light.png` (the "Ready to order?" card).

## Passkey wallet (I2), ADR-0402

`lib/holder-passkey.ts`, `components/portfolio/passkey-wallet.tsx` (a Wallet Standard wallet registered for the whole app, and a card on `/portfolio`). The key is derived from a passkey with the WebAuthn PRF extension on every request and dropped; nothing is stored but a marker that a passkey exists.

Tests: `apps/web/test/holder-passkey.test.ts` (6): same secret same wallet, another secret another wallet, the seed is an HKDF expansion and not the secret, the key is non-extractable, a signed message verifies against the address and not another, a transaction signature fills only its own slot and keeps another signer's.

Browser run `apps/web/e2e/holder-passkey-flow.mjs`, Chromium with a virtual authenticator that has PRF, user verification and resident keys:

```
PASS passkey: the card says it is a devnet preview
PASS passkey: the wallet is listed beside installed wallets
PASS passkey: connecting made a passkey and a wallet address
PASS passkey: only a marker that a passkey exists is stored
PASS passkey: nothing in browser storage looks like a key
PASS passkey: the signature verifies against the wallet address
PASS passkey: a reload does not reconnect silently (the person must be present)
PASS passkey: the same passkey gives the same wallet after a reload
PASS passkey: portfolio page axe clean with the wallet connected
PASS passkey holder: zero console errors, page errors, failed requests and HTTP errors
```

Not covered: a physical authenticator, Safari, Firefox, a platform that syncs passkeys across devices (the same-wallet-on-another-device claim rests on the PRF specification and was shown here only as the same wallet after a reload), signing a real devnet transaction with this wallet, and any audit of it. The card says devnet preview and not to hold anything of value.
