// The one provider the kit needs: where the API and the cluster are, which wallet signs, and where sealed-bid salts are kept.
import { type ReactNode, createContext, useContext, useMemo } from 'react';
import {
  type ApiClient,
  type ClientStore,
  type HttpDeps,
  type RpcClient,
  type TxBuilder,
  apiTxBuilder,
  createApiClient,
  createRpcClient,
  localTxBuilder,
  memoryStore,
  storageStore,
} from '@opening-cross/client';
import type { Signer } from './signer.js';

/** The connected wallet: its address and the function that signs for it. */
export type Wallet = { address: string; sign: Signer };

export type OpeningCrossProviderProps = HttpDeps & {
  /** The Opening Cross API, for example `https://api.example.com`. */
  apiUrl: string;
  /** A Solana RPC endpoint. Needed to send transactions, to confirm them, and for chain verification. */
  rpcUrl: string;
  /** The connected wallet, or null for a read-only view. */
  wallet?: Wallet | null;
  /** Where sealed-bid salts and placed-order addresses are kept. Default: the browser's localStorage under the web app's keys, or memory when storage is unavailable. */
  store?: ClientStore;
  /**
   * How transactions are built: by the API (`api`, the default: one request, the API reads the chain) or in the browser from chain
   * state (`local`: nothing the API says is ever signed).
   */
  build?: 'api' | 'local';
  children?: ReactNode;
};

export type OpeningCross = {
  api: ApiClient;
  rpc: RpcClient;
  builder: TxBuilder;
  wallet: Wallet | null;
  store: ClientStore;
  sleep?: (ms: number) => Promise<void>;
};

const Ctx = createContext<OpeningCross | null>(null);

function defaultStore(): ClientStore {
  try {
    const probe = '__opening_cross_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return storageStore(globalThis.localStorage);
  } catch {
    // Private windows and blocked storage throw; a session store still lets a sealed bid be revealed before the tab closes.
    return memoryStore();
  }
}

export function OpeningCrossProvider({ apiUrl, rpcUrl, wallet = null, store, build = 'api', fetch: fetchImpl, sleep, children }: OpeningCrossProviderProps) {
  const deps = useMemo(() => ({ ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(sleep ? { sleep } : {}) }), [fetchImpl, sleep]);
  const api = useMemo(() => createApiClient({ baseUrl: apiUrl, ...deps }), [apiUrl, deps]);
  const rpc = useMemo(() => createRpcClient({ url: rpcUrl, ...deps }), [rpcUrl, deps]);
  const fallbackStore = useMemo(defaultStore, []);
  const value = useMemo<OpeningCross>(
    () => ({ api, rpc, builder: build === 'local' ? localTxBuilder(rpc) : apiTxBuilder(api), wallet, store: store ?? fallbackStore, ...(sleep ? { sleep } : {}) }),
    [api, rpc, build, wallet, store, fallbackStore, sleep],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The provider's contents. Throws a clear error when used outside `OpeningCrossProvider`. */
export function useOpeningCross(): OpeningCross {
  const v = useContext(Ctx);
  if (!v) throw new Error('Opening Cross hooks and components must be rendered inside <OpeningCrossProvider>.');
  return v;
}
