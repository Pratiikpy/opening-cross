# @opening-cross/client

The framework-free client of [Opening Cross](https://github.com/Pratiikpy/opening-cross): a typed API client, exact unit maths, order
validation and previews, a signing and sending pipeline with human error messages, chain readers that verify the API, transaction builders
(local and through the API), and the sealed-bid vault. `@opening-cross/react` and `@opening-cross/cli` are built on it; use it directly for a
bot, a server or a UI in another framework.

```ts
import { createApiClient, createRpcClient, localTxBuilder, signSendConfirm, validateOrderInput, marketOf, previewOrder } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';

const api = createApiClient({ baseUrl: 'https://api.example.com' });
const rpc = createRpcClient({ url: 'https://api.devnet.solana.com' });
const cross = await api.getCross('<cross address>');

// Validate what a person typed against the cross's price grid, and say what it commits them to.
const market = marketOf(cross);
const v = validateOrderInput(cross, market, { side: 'buy', priceText: '1.25', quantityText: '10' });
if (!v.ok) throw new Error(v.priceError ?? v.quantityError ?? 'incomplete');
console.log(previewOrder(cross, market, 'buy', v.price, v.quantity).lines);

// Build from chain state (nothing an HTTP server composed is ever signed), sign with a keypair file, send, confirm.
const { address, sign } = await loadKeypairSigner(process.env.KEYPAIR!);
const built = await localTxBuilder(rpc).placeOrder({ cross: cross.address, owner: address, nonce: 1n, side: 'buy', price: v.price, quantity: v.quantity });
const signatures = await signSendConfirm(built.transactions, { rpc, sign });
```

## Modules

| Module | What it gives you |
| --- | --- |
| `units` | `formatAtoms`, `parseAtoms`, `formatPrice`, `parsePrice`, `buyerPays`, `sellerReceives`, `feeOf`, `formatDuration`, `formatSol`. Bigint end to end; parsing refuses anything that would round. |
| `api` | `createApiClient`: typed reads and unsigned-transaction builders for the REST API, retry on 429 and 5xx, `routeQuote` that returns `unavailable` on a deployment without the router. |
| `rpc` | `createRpcClient`: the handful of JSON-RPC calls a client needs, with backoff on rate limits and a cluster-clock reader. |
| `pipeline` | `signSendConfirm` (signs a multi-transaction action in one wallet prompt when the signer allows, sends in order, confirms, reports how many landed on a partial failure) and `dryRun`. |
| `order` | `validateOrderInput`, `priceOnGrid`, `previewOrder` (escrow, most you can pay, fees, what happens if the cross fails, refund path), `phaseOf`, `describeOrder`. |
| `chain` | `readCrossFromChain`, `readBookFromChain`, `compareCross`: the trustless half of "state from the API with chain verification". |
| `tx-builder` | `apiTxBuilder` and `localTxBuilder` behind one `TxBuilder` interface. |
| `sealed` | `SealedVault`, `memoryStore`, `storageStore` (same keys and backup schema as the Opening Bell web app), `parseBackup`, `importBackup`. |
| `explain` | `explainFailure`: turns program logs and error codes into a sentence a person can act on. |
| `@opening-cross/client/node` | `loadKeypairSigner` and `fileStore` (Node only). The key is read, used in memory and forgotten; this package never generates or stores keys. |

Apache-2.0.
