import { useMemo } from 'react';
import { type ActionError, type CrossComparison, type CrossDetail, type Phase, compareCross, phaseOf, readCrossFromChain } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useClock } from './use-clock.js';
import { type Resource, useResource } from './use-resource.js';

/** Where a result is checked against the cluster: not at all, instead of the API, or alongside it. */
export type VerifyMode = 'none' | 'chain' | 'both';

export type Verification = {
  /**
   * `verified`: the API and the cluster agree on every field. `mismatch`: they disagree on something that is not expected to move
   * between two reads. `inconclusive`: they differ only on fields that change as orders arrive; the next read settles it.
   * `unavailable`: one side could not be read, so there is nothing to compare. `off`: not asked for.
   */
  status: 'off' | 'verified' | 'mismatch' | 'inconclusive' | 'unavailable';
  differences: CrossComparison['differences'];
  /** Why a side could not be read, when `unavailable`. */
  reason: string | null;
};

const OFF: Verification = { status: 'off', differences: [], reason: null };

type Loaded = { cross: CrossDetail; source: 'api' | 'chain'; verification: Verification; clockOffset: bigint };

export type UseCross = {
  status: Resource<Loaded>['status'];
  cross: CrossDetail | null;
  /** Which reader produced `cross`. */
  source: 'api' | 'chain' | null;
  verification: Verification;
  phase: Phase | null;
  /** Unix seconds on the cluster's clock when it was read, otherwise this machine's. Ticks every second. */
  now: bigint;
  error: ActionError | null;
  stale: boolean;
  refresh: () => Promise<void>;
};

export type UseCrossOptions = {
  verify?: VerifyMode;
  /** Re-read this often, in milliseconds (default 15000; 0 turns polling off). */
  pollMs?: number;
  /** Re-read when the API's event stream reports something for this cross (default true). */
  stream?: boolean;
};

/**
 * A cross, with an optional check against the cluster itself. With `verify: 'chain'` the API is not used at all; with `'both'` the
 * API's answer is compared field by field with one decoded from the cross account, and the result says whether they agree.
 */
export function useCross(address: string | null, options: UseCrossOptions = {}): UseCross {
  const { api, rpc } = useOpeningCross();
  const verify = options.verify ?? 'none';
  const r = useResource<Loaded>(
    address === null ? null : `${address}:${verify}`,
    async (signal) => {
      const addr = address!;
      if (verify === 'none') return { cross: await api.getCross(addr, signal), source: 'api', verification: OFF, clockOffset: 0n };
      const chainRead = readCrossFromChain(rpc, addr).then(async (c) => ({ c, offset: (await rpc.unixTime()) - BigInt(Math.floor(Date.now() / 1000)) }));
      if (verify === 'chain') {
        const { c, offset } = await chainRead;
        return { cross: c.detail, source: 'chain', verification: OFF, clockOffset: offset };
      }
      const [fromApi, fromChain] = await Promise.allSettled([api.getCross(addr, signal), chainRead]);
      if (fromApi.status === 'fulfilled' && fromChain.status === 'fulfilled') {
        const cmp = compareCross(fromApi.value, fromChain.value.c.detail);
        const status: Verification['status'] = cmp.matches ? 'verified' : cmp.differences.every((d) => d.volatile) ? 'inconclusive' : 'mismatch';
        return { cross: fromApi.value, source: 'api', verification: { status, differences: cmp.differences, reason: null }, clockOffset: fromChain.value.offset };
      }
      if (fromApi.status === 'fulfilled') return { cross: fromApi.value, source: 'api', verification: { status: 'unavailable', differences: [], reason: `the cluster could not be read: ${String((fromChain as PromiseRejectedResult).reason?.message ?? 'unknown error')}` }, clockOffset: 0n };
      if (fromChain.status === 'fulfilled') return { cross: fromChain.value.c.detail, source: 'chain', verification: { status: 'unavailable', differences: [], reason: `the API could not be read: ${String((fromApi as PromiseRejectedResult).reason?.message ?? 'unknown error')}` }, clockOffset: fromChain.value.offset };
      throw (fromApi as PromiseRejectedResult).reason;
    },
    {
      pollMs: options.pollMs ?? 15_000,
      subscribe: options.stream === false || address === null || verify === 'chain' ? undefined : (refresh) => api.subscribe(address, (e) => e.type === 'event' && refresh()),
    },
  );
  const now = useClock(r.data?.clockOffset ?? 0n);
  const phase = useMemo(() => (r.data ? phaseOf(r.data.cross, now) : null), [r.data, now]);
  return { status: r.status, cross: r.data?.cross ?? null, source: r.data?.source ?? null, verification: r.data?.verification ?? OFF, phase, now, error: r.error, stale: r.stale, refresh: r.refresh };
}
