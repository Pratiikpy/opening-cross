# ADR-0402: A wallet that lives in a passkey (devnet preview)

Status: accepted (2026-10-13)

Row I2

## Context

An embedded wallet normally means a vendor (Privy, Web3Auth, Turnkey) and an account with it. Email or social sign-in cannot be built without one. A passkey can.

## Decision

A Wallet Standard wallet, registered by the app, whose key is derived on demand from a passkey with the WebAuthn PRF extension: the passkey answers a fixed label with 32 secret bytes after the person verifies themselves, HKDF expands them to an Ed25519 seed, WebCrypto imports it as a non-extractable key, and it signs one request. Nothing is stored. The same synced passkey is the same wallet on every device; a deleted passkey is a lost wallet, and the card says so. Every signature asks for the fingerprint, face or PIN again. It is labelled a devnet preview and not audited.

Not done: email and social sign-in (needs a provider account: HUMAN_TASKS), account recovery beyond the platform's passkey sync, sponsored creation of the first transaction (see ADR-0405 for fee sponsorship).

## Verification

Unit tests of the derivation and signing (`holder-passkey.test.ts`) and a browser run against Chrome's virtual authenticator with PRF (docs/evidence/W2C-I2.md). Not run on a physical authenticator or on Safari or Firefox.
