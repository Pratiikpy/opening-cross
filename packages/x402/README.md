# @opening-cross/x402

Pay per call on Solana, for HTTP and MCP. One gate serves two open protocols from the same route:

- **x402 v2**, scheme `exact` (coinbase/x402, `specs/schemes/exact/scheme_exact_svm.md`): the buyer signs an SPL token `TransferChecked`, the server's fee payer co-signs and settles.
- **MPP**, intent `charge` on the `solana` method (`draft-solana-charge-00` at paymentauth.org): `WWW-Authenticate: Payment` challenge, `Authorization: Payment` credential, `Payment-Receipt`. Pull mode with a sponsored fee payer.

It contains the server gate, a self-hosted facilitator, a facilitator HTTP client and routes, a buyer client that pays within limits it is given, and a Postgres ledger of every payment.

## What it guarantees

A buyer is never charged for a response that was not produced, and a payment buys one response.

1. An unpaid call returns real requirements and a real sample of the paid response. The route validates the request first, so a request that cannot be answered gets a 4xx and no price.
2. The challenge is tied to one request, one price and one expiry by a keyed MAC carried in the transaction memo (x402) or in the challenge id (MPP). A payment cannot be moved to another route, another query or another price.
3. The payment is verified without trusting the sender: the transaction is decoded, the fee payer must not appear in any instruction, the amount, mint and destination token account are recomputed, the payer's signature is checked, the priority fee is capped, and the result is simulated with the fee payer's signature before anything is broadcast.
4. The work runs before settlement. If it fails, nothing settles and the same payment can be presented again.
5. One payment, one claim: the ledger's primary key is the hash of the transaction message, so of any number of concurrent requests with one payment exactly one is served.
6. If settlement does not confirm, the payment stays claimed and a retry of the same request is reconciled against the chain instead of paying twice. A background `gate.reconcile()` closes what a crashed process left behind.

## Use

```ts
import { LocalFacilitator, PaymentLedger, X402Gate, createRpc, migrate, networkOf, registerPaidRoute } from '@opening-cross/x402';

const rpc = createRpc(process.env.RPC_URL!);
const network = await networkOf(rpc);                        // CAIP-2, read from the cluster
await migrate(pool);                                          // x402_attempts, x402_payments
const facilitator = new LocalFacilitator({ rpc, network, signers: [feePayer], policy: { payTo: [recipient], assets: [mint] }, minFeePayerLamports: 5_000_000n });
const gate = new X402Gate({ facilitator, ledger: new PaymentLedger(pool), network, asset: mint, payTo: recipient, secret,
  mpp: { realm: 'api.example.com', network: 'mainnet', decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS } });   // `mpp` is optional

registerPaidRoute(app, gate, {
  method: 'GET', url: '/v1/paid/report/:id', description: 'The report',
  prepare: async (req) => {
    const report = await load(req);                           // throws for a bad request: a 4xx, never a price
    return { amount: 25_000n, preview: async () => summary(report), full: async () => report };
  },
});
```

The buyer side:

```ts
const payFetch = createPayFetch({ signer, rpc, limits: { maxAmount: 100_000n, assets: [mint], payTo: [recipient] } });
const { response, paid } = await payFetch('https://api.example.com/v1/paid/report/7');   // paid.transaction is the signature
```

`limits.maxAmount` is required and there is no default. Nothing is signed that the limits do not allow. Pass `prefer: 'mpp'` to pay the MPP challenge when a server offers both.

## Facilitator

`LocalFacilitator` signs as the fee payer. It refuses to sponsor a transfer whose recipient or mint is not in its `policy`, because a fee payer that signs for any requirements can be drained by paying oneself. `registerFacilitatorRoutes` serves the standard `POST /verify`, `POST /settle`, `GET /supported` behind a bearer token, and `HttpFacilitator` is the matching client, so a resource server can use this repository's facilitator or any other that speaks the same wire format. A remote facilitator does not know the MPP compute-budget order (below); keep MPP on a `LocalFacilitator`.

## Where it follows the specifications, and where it does not

- Instruction layout: compute limit, compute price, one `TransferChecked`, then at most three of Memo and Lighthouse. For MPP the price may come before the limit, because the official client emits that order; this is accepted for MPP only.
- The x402 scheme leaves the memo to the seller (`extra.memo`). The memo here is a 36-byte token (`oc1.<expiry>.<nonce>.<mac>`). Memo v3 costs about 350 compute units per byte, so the client sets its compute limit from the memo size.
- MPP: only `type="transaction"`. `type="signature"` is refused as the specification requires with a sponsored fee payer; confidential `bundle` payments, splits, native SOL and the session intent are not offered. Problem documents use the registered problem types and every payment failure is a 402 with a fresh challenge.
- Devnet, testnet and mainnet are distinguished by the genesis hash the server reads from its own RPC; nothing is hard-coded.

## Tests

`pnpm --filter @opening-cross/x402 test`. The unit tests need nothing. `test/payments.test.ts` and `test/api-paid-routes.test.ts` need a local `solana-test-validator` on `X402_TEST_RPC` (default `127.0.0.1:8940`) and Postgres on `DATABASE_URL`; they skip themselves when no validator answers. They create a real mint, token accounts and a fee payer, and read every outcome back from token balances, fee payer lamports and signature status. `test/api-paid-routes.test.ts` mounts the API's own `registerPaid` (services/api) behind the real gate and pays its three routes over MPP and x402, and with `MPP_INTEROP_DIR` set also with the official client (ADR-0965). It imports `services/api` and sibling packages by path, so `tsconfig.test.json` leaves it out of `typecheck`; it was checked on its own.

The MPP interoperability test pays with the official Solana Foundation client in a separate process. It needs that client installed outside the repository and `MPP_INTEROP_DIR` pointing at it; it skips otherwise:

```
mkdir mpp-interop && cd mpp-interop && npm init -y && npm i @solana/mpp@0.7.0 @solana/kit@6 mppx@0.13.4
MPP_INTEROP_DIR=$PWD pnpm --filter @opening-cross/x402 test
```

On Windows the validator does not start (it cannot unpack its genesis archive); run it in WSL and Postgres in a container, both on the loopback address, for example `solana-test-validator --reset --rpc-port 8940` and `docker run -e POSTGRES_PASSWORD=oc -p 127.0.0.1:55434:5432 postgres:17` with `DATABASE_URL=postgres://postgres:oc@127.0.0.1:55434/postgres`.

