# W3D-B5: the accepted amount and pushed refunds (decision)

Outcome: **NOT DOING (accepted amount, mechanism change); on-chain part complete (refunds), keeper is the application layer.** ADR-0661. Row B5.

- The accepted amount stays a rule published before bids (the hard cap and the minimum raise). A choice after the book is visible lets an issuer withhold supply to raise the uniform price. A variant that removes the lever (sell less at the full-supply price) is a clearing-rule change that must live in `clearing-core`, its WebAssembly build, the Python simulator and the TypeScript verifier, with new conformance vectors beside the 525 that exist; it is a workstream A decision, not a program addition (ADR-0661 has the reasoning).
- `push_refunds` is on chain, permissionless and tested (`rules-refunds.test.ts`: 3 tests plus the shared claim path). A program cannot start a transaction, so a keeper sends it.

## FEATURE_STATUS wording

No change to the B5 row's claims; the Gap text should add: "the accepted-amount variant that cannot raise the price is a clearing-rule change (ADR-0661), not built".

## What the app layers must add

Keeper: after a cross is cleared or not printed, send `push_refunds` for the refund-only orders, twelve per transaction (the builder and the route exist: `W3A-offchain-layer.md`); the claim center and the orders page already show a pushed refund. Not covered here: the keeper.
