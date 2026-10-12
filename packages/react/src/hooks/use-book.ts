import { type ActionError, type BookResponse, readBookFromChain, readCrossFromChain } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import type { Verification, VerifyMode } from './use-cross.js';
import { useResource } from './use-resource.js';

export type UseBook = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  book: BookResponse | null;
  source: 'api' | 'chain' | null;
  verification: Verification;
  error: ActionError | null;
  refresh: () => Promise<void>;
};

const OFF: Verification = { status: 'off', differences: [], reason: null };

/** What differs between the API's book and the cluster's, as sentences; empty when they agree. */
export function bookDifferences(a: BookResponse, b: BookResponse): string[] {
  const out: string[] = [];
  const key = (l: BookResponse['levels'][number]) => `${l.price}:${l.buy}:${l.sell}:${l.buyOrders}:${l.sellOrders}`;
  const left = new Set(a.levels.map(key));
  const right = new Set(b.levels.map(key));
  for (const k of left) if (!right.has(k)) out.push(`level ${k} is in the API's book but not the cluster's`);
  for (const k of right) if (!left.has(k)) out.push(`level ${k} is in the cluster's book but not the API's`);
  if ((a.indicative?.price ?? null) !== (b.indicative?.price ?? null)) out.push(`indicative price: the API says ${a.indicative?.price ?? 'none'}, the cluster says ${b.indicative?.price ?? 'none'}`);
  return out;
}

/** The resting book of a cross and the price it would clear at now, optionally checked against the cluster (see `useCross`). */
export function useBook(address: string | null, options: { verify?: VerifyMode; pollMs?: number } = {}): UseBook {
  const { api, rpc } = useOpeningCross();
  const verify = options.verify ?? 'none';
  const r = useResource<{ book: BookResponse; source: 'api' | 'chain'; verification: Verification }>(
    address === null ? null : `${address}:${verify}`,
    async (signal) => {
      const addr = address!;
      const fromChain = async () => {
        const c = await readCrossFromChain(rpc, addr);
        return readBookFromChain(rpc, addr, c.data);
      };
      if (verify === 'none') return { book: await api.getBook(addr, signal), source: 'api', verification: OFF };
      if (verify === 'chain') return { book: await fromChain(), source: 'chain', verification: OFF };
      const [a, c] = await Promise.allSettled([api.getBook(addr, signal), fromChain()]);
      if (a.status === 'fulfilled' && c.status === 'fulfilled') {
        const diffs = bookDifferences(a.value, c.value);
        // Orders arrive between the two reads, so a difference in a live book is not proof of a fault; the next read settles it.
        const status = diffs.length === 0 ? 'verified' : 'inconclusive';
        return { book: a.value, source: 'api', verification: { status, differences: diffs.map((d) => ({ path: d, api: null, chain: null, volatile: true })), reason: null } };
      }
      if (a.status === 'fulfilled') return { book: a.value, source: 'api', verification: { status: 'unavailable', differences: [], reason: 'the cluster could not be read' } };
      if (c.status === 'fulfilled') return { book: c.value, source: 'chain', verification: { status: 'unavailable', differences: [], reason: 'the API could not be read' } };
      throw (a as PromiseRejectedResult).reason;
    },
    { pollMs: options.pollMs ?? 15_000 },
  );
  return { status: r.status, book: r.data?.book ?? null, source: r.data?.source ?? null, verification: r.data?.verification ?? OFF, error: r.error, refresh: r.refresh };
}
