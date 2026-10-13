# W2A-X6, J1, X11, P1, P3 to P5: pay-per-call wired into the API, run on devnet

Rows: X6 and Y7 (x402 and MPP agent order entry, wired into the API behind configuration), J1 (agent-native API with pay-per-call), X11 and P1 (metered line: proof verification API), P3 to P5 (pay-per-call data). Date: 2026-10-13. Cluster: Solana devnet. Code: `services/api/src/routes/paid.ts` (the routes), `services/api/src/routes/paid-config.ts` (the gate from the environment), `services/api/scripts/paid-devnet.ts` (this run), `packages/x402` (the gate, facilitator, ledger, client), `packages/attest` (signed documents), `packages/fees` (the rate card).

## What is sold

Nothing here is data that the free API withholds. Every fact below is also free at the unchanged public routes. A payment buys a service on top of it.

| Route | Price (proposed rate card, USDC-style 6 decimals) | What a payment adds to the free preview |
|---|---|---|
| `GET /v1/paid/verify/:cross` | 0.01 (10,000 atoms), product `proof-verification` | The verdict of the independent recomputation is the free preview. Payment returns it as a document signed by the published attestation key, with the hash of the full proof, plus the proof. |
| `GET /v1/paid/bundle/:cross` | 0.05 (50,000), product `data-export` | The cross, every order, every event and the proof in one signed document with a hash of each part. |
| `POST /v1/paid/order-desk` | 0.02 (20,000), new product `order-desk` | The unsigned order transaction for an agent, and the cluster's own simulation of it. The preview already shows the escrow, fee, phase and seconds left. |

The prices come from `PROPOSED_RATE_CARD` (status `proposed`); the descriptions say so. Nothing measures willingness to pay.

## The run

A real Token-2022 payment mint `FkGxNSEg5p8qeZzz7tjHY4HXMgnqjDZCqho1LoHieJhY` was created (a stand-in for USDC on devnet), a recipient wallet `FwDKHvSvQi8L7RJuiiedTouzrqvToGXJE2UQph2xa392`, a fee-payer wallet `8xoVLvchEYf9miDCYDMoNLgdvVjvJg5pJ3zKNn7WJXZk` funded with 0.02 SOL, and a buyer (the market-maker run's taker `ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm`, which holds no SOL it spends on payments) with 5 payment tokens. The route module ran behind the real `X402Gate`, `LocalFacilitator` and Postgres ledger, on a local port, reading devnet. The buyer paid with `createPayFetch` with `maxAmount` 100,000 and the mint and recipient pinned.

| Call | Result |
|---|---|
| `POST /v1/paid/order-desk` with `{"cross":"nope"}` | 400 `cross must be a base58 Solana address`, no price offered (the careless buyer). |
| Unpaid `GET /v1/paid/verify/DfggnrfM...` (the finalized maker run, see `W2A-X6-marketmaker.md`) | 402 with requirements (`amount` 10000) and a real preview: `verified: true`, on-chain and recomputed price 1550000, matched 100000000. |
| Paid `GET /v1/paid/verify/DfggnrfM...` | 200. Payment transaction `45WuGTnxP5KaBJgQw3jsWdBVh4jeFfJovCDRgwNGoJKsCt3B3RvZocZacSraCGFJ5AyKjogaMRbDXotZRoU3HLdx`. The receipt is a `opening-cross/verification-receipt/v1` document with `proofSha256` `be2e3ac4fa42c0a5aa9d3fd61060812285c8f247e9ff26258b2a55fb0674e693`, signed by `8nsSrBVk489LdfceYGyRBGEUjJ6LgabuYNmLvCQAMhs6`, which `/v1/attestations/signer` publishes; `verifyDocument` against the published signer returned `ok`. |
| Unpaid `POST /v1/paid/order-desk` on the live cross `FFQqs2za...` | 402 with a preview: escrow 16000000 quote atoms for 10 base at 1.60, no fee for buyers, open call, 6955 s left. |
| Paid `POST /v1/paid/order-desk` | 200. Payment transaction `4RnqfQWUycFmkv71mmHfTmdu1MkZAF9iPHqZbTGzmyUArrPmEURJKhrXHiLHUpjgFmRuBbqpNUxa4muA7bhTvMkS`. The response carried the unsigned transaction, its signer (the buyer), and the cluster's simulation of the place-order against the real deployed program: `wouldSucceed: true`, 21,765 compute units, the log lines of the system and Token-2022 transfer. |

Source of truth, read from the chain after the calls (`getTokenAccountsByOwner`): the recipient held 70,000 atoms and the buyer 4,930,000 of the 5,000,000 minted. 70,000 is exactly three verify payments (30,000) and two desk payments (40,000): the desk payment above and one that landed late (next section). The ledger (`x402_payments`) held the four payments the server had confirmed, with matching signatures; the fifth was still `unconfirmed` in `x402_attempts` for the reconciler.

## Failures observed and what they showed

These happened on the shared public devnet endpoint, which rate limits, and each is the behaviour the gate promises:

- A desk payment whose settlement the facilitator could not confirm in 60 s: the buyer got 503 `settlement_unconfirmed`, "do not pay again; retry the same request with the same payment". The transaction `4nHmVDdPky5BEKMnVeuUZ9rKDfqc4xuSPEcvndG9DtrjFE7d4kJdE96D7bgBa2Cx8s59WwfMZrQHgZTPu5DR81ku` did land and finalized on chain a few minutes later; the ledger kept it `unconfirmed` for the reconciler (`gate.reconcile()`, which closes a payment the chain shows as landed after 150 s). Cause found: a failed status poll (HTTP 429) escaped the confirmation loop, ending the resend loop early. Fixed in `packages/x402/src/facilitator.ts` (a failed poll is treated as "not seen yet"); `packages/x402/test/confirm.test.ts` covers it (2 tests). The 90 s default wait is now configurable (`X402_CONFIRM_TIMEOUT_MS`).
- An order-desk call whose pre-trade simulation was refused with "Connection rate limits exceeded": returned 422 before the payment settled and the buyer lost nothing (balances: buyer -10,000 for the verify only). That mapping is now a 503 with `Retry-After` (a busy endpoint is the API's upstream), covered by the route's error mapping.
- One run's payment never reached the chain (`dHc2y4hENspG...`, the status poll failure above, before the fix): the ledger row is `unconfirmed` and the chain has no such signature; the blockhash expires and the reconciler releases it. The buyer was not charged.

## Covered and not covered

Covered: the unpaid, paid, bad-request, junk-body, unconfigured (501) and unsettled-cross (409) states over HTTP with the real gate for x402; the signature check of the receipt against the published signer; the chain balances. `services/api/test/paid.test.ts` (8 tests, stand-in gate, real receipts, real database) and `packages/x402` (unchanged tests plus 2 new).

Not covered: MPP over the API (the code path is `X402_MPP_REALM` in `paid-config.ts`; `packages/x402` already pays it with the official client in WSL, `X6-integration-tests.md`, but it was not run through these routes), the bundle route against the live index (tested against a database with inserted rows; the deployed API's database was not used), reuse of one payment for a second request (covered by the x402 package's own integration tests, which need a validator and were not re-run here), mainnet, and the deployed stack: these routes are not in the deployed API until `registerPaid` is wired into `services/api/src/server.ts` and `main.ts` and the stack is redeployed. Wiring and variables are listed in the final report; the human steps are in `docs/HUMAN_TASKS.md` (H27).
