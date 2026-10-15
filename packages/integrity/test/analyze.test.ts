// The organic-volume pipeline end to end over a scripted chain and a scripted Jito explorer: orders in, guard decision out.
import { describe, expect, it } from 'vitest';
import { MemoryFundingCache, MemoryPlacementStore, analyzeCross, declaredTeamFrom, type AnalyzedOrder, type RpcLike } from '../src/index.js';

const NOW = 1_792_100_000;
const BUNDLE = 'c'.repeat(64);
const PARTIES = { address: 'CROSS', creator: 'CREATOR', proceedsTo: 'CREATOR', integrator: 'INTEG', feeRecipient: 'FEE' };

/** Wallet W was funded by FUNDER-W (or by a shared funder for the names in `sharedFunder`); order account `ord-X` was placed by transaction `place-X`. */
function chain(sharedFunder: Record<string, string> = {}): RpcLike {
  return {
    async call<T>(method: string, params: unknown[] = []) {
      if (method === 'getSignaturesForAddress') {
        const a = params[0] as string;
        return (a.startsWith('ord-') ? [{ signature: `place-${a.slice(4)}`, slot: 5, err: null, blockTime: NOW - 60 }] : [{ signature: `fund-${a}`, slot: 1, err: null, blockTime: NOW - 86_400 }]) as T;
      }
      const sig = params[0] as string;
      if (!sig.startsWith('fund-')) return null as T;
      const w = sig.slice(5);
      return { blockTime: 1, meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: sharedFunder[w] ?? `FUNDER-${w}`, destination: w, lamports: '5000' } } }] } } } as T;
    },
  };
}
const explorer = (bundled: string[], payer: string): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/bundles/bundle/')) return new Response(JSON.stringify([{ bundleId: BUNDLE, slot: 5, validator: 'V', tippers: [payer], landedTipLamports: 1000, txSignatures: bundled }]), { status: 200 });
    const sig = url.split('/transaction/')[1]!;
    return bundled.includes(sig) ? new Response(JSON.stringify([{ bundle_id: BUNDLE }]), { status: 200 }) : new Response(JSON.stringify({ error: 'Bundle not found' }), { status: 400 });
  }) as typeof fetch;

function population(honest: number, sybils: number): AnalyzedOrder[] {
  const orders: AnalyzedOrder[] = [];
  for (let i = 0; i < honest; i++) orders.push({ owner: `H${i}`, orderAddress: `ord-H${i}`, side: i % 2 ? 'sell' : 'buy', weight: 100n });
  for (let i = 0; i < sybils; i++) orders.push({ owner: `S${i}`, orderAddress: `ord-S${i}`, side: i % 2 ? 'sell' : 'buy', weight: 100n });
  return orders;
}

describe('analyzeCross', () => {
  it('passes a population with no link between its bidders and attests the independent volume', async () => {
    const r = await analyzeCross({ parties: PARTIES, orders: population(24, 0) }, { rpc: chain(), cache: new MemoryFundingCache(), bundles: { explorer: { fetch: explorer([], 'X'), now: () => NOW } } });
    expect(r.guard.decision).toBe('pass');
    expect(r.guard.attestableBase).toBe(2400n);
    expect(r.coordination!.notBundled).toBe(24);
    expect(r.untracedOwners).toEqual([]);
  });

  it('catches sybils that a funding trace cannot see because a bundle one of them paid for placed their orders together', async () => {
    const orders = population(24, 6);
    const sybilTx = Array.from({ length: 6 }, (_, i) => `place-S${i}`);
    const withBundles = await analyzeCross({ parties: PARTIES, orders }, { rpc: chain(), cache: new MemoryFundingCache(), bundles: { explorer: { fetch: explorer(sybilTx, 'S0'), now: () => NOW }, store: new MemoryPlacementStore() } });
    expect(withBundles.coordination!.coordinated.sort()).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    expect(withBundles.organic.crossSideClusters).toHaveLength(1);
    expect(withBundles.guard.decision).toBe('fail');
    expect(withBundles.guard.attestableBase).toBe(0n);
    // The same population measured without the bundle check looks clean, which is the gap the evidence closes.
    const withoutBundles = await analyzeCross({ parties: PARTIES, orders }, { rpc: chain(), cache: new MemoryFundingCache(), bundles: false });
    expect(withoutBundles.coordination).toBeNull();
    expect(withoutBundles.guard.decision).toBe('pass');
    expect(withoutBundles.organic.barsUnmet[0]).toMatch(/No Jito bundle data was gathered/);
  });

  it('a shared funder still clusters, and the issuer bidding is still flagged', async () => {
    const orders = [...population(24, 0), { owner: 'CREATOR', orderAddress: 'ord-CREATOR', side: 'buy' as const, weight: 900n }];
    const shared = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`H${i}`, 'ONE-FUNDER']));
    const r = await analyzeCross({ parties: PARTIES, orders }, { rpc: chain(shared), cache: new MemoryFundingCache(), bundles: false });
    expect(r.clusters.clusters).toHaveLength(1);
    expect(r.conflicts.perOwner.CREATOR![0]!.kind).toBe('issuer');
    expect(r.guard.decision).toBe('fail'); // 900 of 3300 is conflicted
  });

  it('an owner whose history cannot be read is unknown, never independent, and the guard holds instead of attesting', async () => {
    const flaky: RpcLike = { call: (m, p) => (m === 'getSignaturesForAddress' && String(p?.[0]).startsWith('H3') ? Promise.reject(new Error('no endpoint could answer (rate limited)')) : chain().call(m, p)) };
    const r = await analyzeCross({ parties: PARTIES, orders: population(10, 0) }, { rpc: flaky, cache: new MemoryFundingCache(), bundles: false });
    expect(r.untracedOwners).toEqual(['H3']);
    expect(r.organic.perOwner.H3).toBe('unknown-funder');
    expect(r.trace.complete).toBe(false);
  });

  it('declaredTeamFrom keeps only declared-team flags', () => {
    const m = declaredTeamFrom({ A: [{ kind: 'declared-team', strength: 'high', evidence: 'listed by the issuer' }], B: [{ kind: 'issuer', strength: 'high', evidence: 'x' }] });
    expect([...m]).toEqual([['A', 'listed by the issuer']]);
  });
});
