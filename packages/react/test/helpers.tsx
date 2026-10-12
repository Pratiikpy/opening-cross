// Test doubles for the kit: a fake network (API and RPC behind one fetch), a wallet, and cross fixtures. Nothing here is imported by the
// package; the browser test in examples/react-app is the one that runs against a real validator.
import { type ReactNode } from 'react';
import { vi } from 'vitest';
import { type ClientStore, type CrossDetail, type Signer, memoryStore } from '@opening-cross/client';
import { OpeningCrossProvider, type Wallet } from '../src/index.js';

export const API = 'http://api.test';
export const RPC = 'http://rpc.test';
export const ADDRESS = '4Nd1mYQzvgWJS6Z3sBBPCCG9rn8Hhuun7FGQg2jBeqFR';
export const OWNER = '7ZqJ5Hq3JxS8uFGcK9fTSe3XgPb2r4YdnW9ipEwQX1tV';

const NOW = 1_800_000_000n;

export function cross(over: Partial<CrossDetail> = {}, nowSeconds = Number(NOW)): CrossDetail {
  return {
    address: ADDRESS,
    state: 'Live',
    disclosure: 'open',
    kind: 'launch',
    supplyMode: 'escrow',
    creator: OWNER,
    baseMint: '9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde',
    quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    window: { openTs: String(nowSeconds - 60), closeTs: String(nowSeconds + 3_600), revealEndTs: String(nowSeconds + 3_600) },
    grid: { minPrice: '1000000', tick: '50000', ticks: 11, priceScale: '1000000' },
    decimals: { base: 6, quote: 6 },
    fees: { protocolBps: 5, integratorBps: 20, integrator: OWNER },
    orders: { total: 3, open: 3, max: 100 },
    clearing: null,
    noPrintReason: null,
    gateMint: null,
    oracleGuard: false,
    settlement: { settleDeadlineTs: '0', baseBound: true },
    ...over,
  };
}

/** Wire bytes of an "unsigned transaction": one signature slot (a distinct 64-byte value) then a few message bytes. */
export function fakeWire(seedByte: number): string {
  const sig = new Uint8Array(64).fill(seedByte);
  return Buffer.from([1, ...sig, 0x80, 1, 2, 3]).toString('base64');
}

export type Route = (body: unknown, url: URL) => { status?: number; body: unknown; headers?: Record<string, string> };

export type FakeNetwork = {
  fetch: typeof fetch;
  requests: { method: string; url: string; body: unknown }[];
  rpcCalls: string[];
  /** Replace how an API path is answered. */
  route(method: string, path: string, handler: Route): void;
  /** Replace how an RPC method is answered. */
  rpc(method: string, handler: (params: unknown[]) => unknown | { __error: { code?: number; message: string; data?: unknown } }): void;
};

export function fakeNetwork(): FakeNetwork {
  const routes = new Map<string, Route>();
  const rpcHandlers = new Map<string, (params: unknown[]) => unknown>([
    ['sendTransaction', () => 'ok-signature'],
    ['getSignatureStatuses', () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] })],
  ]);
  const net: FakeNetwork = {
    requests: [],
    rpcCalls: [],
    route: (method, path, handler) => void routes.set(`${method} ${path}`, handler),
    rpc: (method, handler) => void rpcHandlers.set(method, handler),
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.origin === RPC) {
        net.rpcCalls.push(body.method);
        const h = rpcHandlers.get(body.method);
        if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `unexpected RPC ${body.method}` } }), { status: 200 });
        const r = h(body.params) as { __error?: unknown } | unknown;
        if (r && typeof r === 'object' && '__error' in r) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: (r as { __error: unknown }).__error }), { status: 200 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }), { status: 200 });
      }
      const method = init?.method ?? 'GET';
      net.requests.push({ method, url: `${url.pathname}${url.search}`, body });
      const handler = routes.get(`${method} ${url.pathname}`);
      if (!handler) return new Response(JSON.stringify({ error: 'no such route' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const r = handler(body, url);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
    }) as unknown as typeof fetch,
  };
  return net;
}

export function fakeWallet(over: { address?: string; sign?: Signer } = {}): Wallet & { sign: Signer & { mock: { calls: unknown[][] } } } {
  const sign = vi.fn(async ({ transaction }: { transaction: Uint8Array }) => ({ signedTransaction: transaction })) as unknown as Signer & { mock: { calls: unknown[][] } };
  return { address: over.address ?? OWNER, sign: (over.sign as typeof sign | undefined) ?? sign };
}

export function Providers({ net, wallet, store, children, build = 'api' }: { net: FakeNetwork; wallet?: Wallet | null; store?: ClientStore; children: ReactNode; build?: 'api' | 'local' }) {
  return (
    <OpeningCrossProvider apiUrl={API} rpcUrl={RPC} fetch={net.fetch} sleep={async () => {}} store={store ?? memoryStore()} wallet={wallet ?? null} build={build}>
      {children}
    </OpeningCrossProvider>
  );
}
