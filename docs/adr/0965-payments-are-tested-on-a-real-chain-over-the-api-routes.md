# ADR-0965: Pay-per-call is tested on a real chain, over the API's own routes, with a real database

Status: accepted (2026-10-16) · Rows X6, J1, P6 · Builds on ADR-0313 (pay-per-call), `W2A-X6-x402-api.md` · Code `packages/x402/test/api-paid-routes.test.ts`, `services/keeper/scripts/referral-proof.ts` · Evidence `W5-1G.md`

## Context

The API's route tests use a stand-in gate (`services/api/test/paid.test.ts`), and the gate's own tests use a test route (`packages/x402/test/payments.test.ts`). Nothing paid the API's real routes (`/v1/paid/verify`, `/bundle`, `/order-desk`) over the MPP charge intent, and no fee had been charged on a real chain by the program that now charges them: the only devnet cross had a zero fee.

## Decision

1. `test/api-paid-routes.test.ts` mounts the API's `registerPaid` behind the real `X402Gate`, a real facilitator, the real Postgres ledger and a `solana-test-validator`, and pays each route as a buyer would: with the package's paying client over MPP and over x402, and with the official `@solana/mpp` client in a separate process when `MPP_INTEROP_DIR` is set (a buyer holding tokens and no SOL; the server sponsors the fee). Every outcome is read back from token balances, signature statuses and the ledger.
2. It states what a careless buyer is owed: a request that cannot be answered gets its 4xx with **no challenge and no price**; a client whose limit is below the price signs nothing; a failure after the payment verified (the RPC behind the order desk is down) charges nothing and records nothing; a credential paid for one order buys nothing for another (`invalid-challenge`, "the payment was not made for this request").
3. The environment is real. Postgres 17 runs in a container (an in-process PGlite was tried and rejected: it serves one session and ignores the per-test `search_path`, so schemas are not isolated). The validator runs in WSL, because the Windows build cannot unpack its genesis archive. The non-zero-fee proof (`referral-proof.ts`) runs a local validator with the repository's own `cross_core` binary.
4. Results are reported with the validator's version, since a local validator is not a cluster.

## Not covered

The deployed API (the routes are off until a payment mint and recipient are set, H29), mainnet, the public facilitator settling a payment, and a wallet extension paying. A Blink client unfurl and a mainnet Jupiter path are not part of this change.
