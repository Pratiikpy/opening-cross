// A chain reader that follows one HTTP request.
//
// `settleTxs` and `finalizeTx` (tx.ts) are called by handlers in server.ts with a decoded cross and no way to read the account
// behind it, but a cross with rules needs its rules tail to build the transaction (the ending buckets to merge, the referrer to
// pay). `registerRulesTx` installs a hook that runs every request inside this context, so those two functions can read the cross's
// raw account without server.ts passing a reader to them. The context belongs to the request, so two servers in one process (the
// tests build several) never read each other's chain. Outside a request there is no context and the builders behave as they did
// before the rules existed.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Address } from '@solana/kit';

export type ChainRead = (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;

const store = new AsyncLocalStorage<{ read: ChainRead; now?: (() => number) | undefined }>();

/** Runs `fn` with `read` as the chain reader of everything it awaits. */
export function withChain<T>(read: ChainRead, fn: () => T, now?: () => number): T {
  return store.run({ read, now }, fn);
}

/** Unix seconds as the server sees them (an injected clock in tests), or null outside a request. */
export function currentNow(): bigint | null {
  const f = store.getStore()?.now;
  return f ? BigInt(f()) : null;
}

/** The chain reader of the current request, or null outside one. */
export function currentChain(): ChainRead | null {
  return store.getStore()?.read ?? null;
}
