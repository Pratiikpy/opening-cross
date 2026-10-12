# @opening-cross/react

Hooks and components for building a client on [Opening Cross](https://github.com/Pratiikpy/opening-cross). React 19, no framework
dependency (works in Vite and Next), wallet-agnostic, accessible, themed with CSS variables.

```tsx
import '@opening-cross/react/styles.css';
import { OpeningCrossProvider, CrossStatus, OrderTicket, OrderList, FairnessReceipt, useCross, useBook, marketOf } from '@opening-cross/react';

function Cross({ address, wallet }: { address: string; wallet: Wallet | null }) {
  return (
    <OpeningCrossProvider apiUrl="https://api.example.com" rpcUrl="https://api.devnet.solana.com" wallet={wallet}>
      <CrossPage address={address} />
    </OpeningCrossProvider>
  );
}

function CrossPage({ address }: { address: string }) {
  // verify: 'both' reads the API and the cross account and says whether they agree.
  const { cross, verification, now } = useCross(address, { verify: 'both' });
  const { book } = useBook(address);
  if (!cross) return null;
  return (
    <>
      <CrossStatus cross={cross} book={book} verification={verification} now={now} />
      <OrderTicket cross={cross} now={now} />
      <OrderList cross={cross} now={now} />
      <FairnessReceipt cross={address} market={marketOf(cross)} state={cross.state} />
    </>
  );
}
```

## Wallets

A wallet is `{ address, sign }`, where `sign({ transaction }) => { signedTransaction }` may also have a `many(transactions)` method that signs
a whole multi-transaction action in one prompt. `walletStandardSigner(feature, account, chain)` adapts any Wallet Standard wallet that implements
`solana:signTransaction`:

```ts
import { walletStandardSigner } from '@opening-cross/react';
const sign = walletStandardSigner(wallet.features['solana:signTransaction'], wallet.accounts[0], 'solana:devnet');
```

## Building transactions

By default the provider asks the API to build them (`build="api"`: one request). With `build="local"` the browser reads the chain and builds the
same instructions itself, so nothing the API says is ever signed.

## Hooks

| Hook | Returns |
| --- | --- |
| `useCross(address, { verify, pollMs, stream })` | the cross, which reader produced it, a `verification` (`verified`, `mismatch`, `inconclusive`, `unavailable`, `off`), the phase and a ticking cluster-clock `now` |
| `useBook(address, { verify })` | the resting book and the indicative clearing price, optionally checked against the cluster |
| `useOrders(cross, owner)` | the wallet's orders: open ones read from chain, closed ones from the index, plus ones placed a moment ago |
| `useFairnessProof(cross)` | the recomputation of the clear against the on-chain book |
| `useBestExecution(intent)` | the best-execution comparison, or `{ status: 'unavailable' }` on a deployment without the router |
| `useAction()` | runs build, sign, send, confirm with step-by-step status and a typed error; never throws |
| `useSealedBids(cross, owner)` | the vault's sealed bids, a backup download and restore |
| `useResource`, `useClock` | the building blocks the others use |

## Components

`CrossStatus`, `OrderTicket` (grid-validated price and quantity; before signing it shows what leaves the wallet, the most you can pay, fees, what
happens if the cross does not print and how to get the money back), `OrderList`, `BookDepth`, `FairnessReceipt`, `BestExecution`, and the buttons
`ActionButton`, `ClaimButton`, `RevealButton`, `CancelButton`, `SettleButton`, `FinalizeButton`.

## Sealed bids

A sealed bid is only a hash on chain. `OrderTicket` writes the price, amount and salt to the vault before it builds anything, then offers a backup
file; the file has the same schema as the Opening Bell web app's, so either can load the other's.

## Theming

Override the `--oc-*` variables (`--oc-accent-fill`, `--oc-bg`, `--oc-ink`, ...) on `:root` or any ancestor. Dark mode follows `prefers-color-scheme`
unless the page sets `data-theme="light"` or `"dark"`.

Apache-2.0.
