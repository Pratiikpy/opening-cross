// F2 and F3/F8: the Jito bundle evidence, the guard over the organic-volume interval, and the paced, resumable mainnet trace.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANIC_POLICY,
  EXPLORER_RETENTION_SECS,
  FileFundingCache,
  JITO_TIP_PAYMENT_PROGRAM,
  MemoryFundingCache,
  bundleOf,
  clusterByFunding,
  FilePlacementStore,
  MemoryPlacementStore,
  coordinationLinks,
  findConflicts,
  jitoTipAccounts,
  organicGuard,
  organicTier,
  organicVolume,
  pacedRpc,
  quoteVolume,
  tipIn,
  traceWallets,
  type Funding,
  type OrderFacts,
  type ParsedTransaction,
  type RpcLike,
} from '../src/index.js';

// The block engine's own list, captured with `getTipAccounts` on 2026-10-15. The live script (scripts/jito-live.ts) repeats the comparison against the running service and
// against the owner of each account on chain; this fixture keeps the derivation honest between runs.
const ENGINE_TIP_ACCOUNTS = [
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
const BUNDLE = 'fea61fd15853c9ff19616946608de54fabdf9704454bcfa331be6b0a922e246a';
const NOW = 1_792_100_000;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const detail = (bundleId: string, tippers: string[], txSignatures: string[] = []) => json(200, [{ bundleId, slot: 5, validator: 'V', tippers, landedTipLamports: 10_000, txSignatures }]);
const explorer = (table: Record<string, Response | (() => Response)>, calls: string[] = [], bundles: Record<string, Response> = {}): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/bundles/bundle/')) return (bundles[decodeURIComponent(url.split('/bundle/')[1]!)] ?? json(404, { error: 'Not found' })).clone();
    const sig = decodeURIComponent(url.split('/transaction/')[1] ?? '');
    const hit = table[sig];
    if (!hit) return json(400, { error: 'Bundle not found' });
    return typeof hit === 'function' ? hit() : hit.clone();
  }) as typeof fetch;

describe('Jito tip accounts', () => {
  it('derive to exactly the accounts the block engine publishes', async () => {
    expect(JITO_TIP_PAYMENT_PROGRAM).toBe('T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt');
    const derived = await jitoTipAccounts();
    expect(derived).toHaveLength(8);
    expect([...derived].sort()).toEqual([...ENGINE_TIP_ACCOUNTS].sort());
  });

  it('tipIn totals the transfers to tip accounts, top level and inner, and ignores every other transfer', async () => {
    const tips = new Set(await jitoTipAccounts());
    const [t0, t1] = [...tips];
    const tx = (instructions: unknown[], inner: unknown[] = []): ParsedTransaction => ({
      blockTime: NOW,
      meta: { err: null, innerInstructions: [{ instructions: inner as never }] },
      transaction: { message: { instructions: instructions as never } },
    });
    const xfer = (source: string, destination: string, lamports: string) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } });
    expect(tipIn(tx([xfer('USER', t0!, '10000')]), tips)).toEqual({ from: 'USER', lamports: 10_000n, to: [t0] });
    expect(tipIn(tx([xfer('USER', t0!, '10000')], [xfer('USER', t1!, '5')]), tips)).toEqual({ from: 'USER', lamports: 10_005n, to: [t0, t1] });
    expect(tipIn(tx([xfer('USER', 'SOMEONE', '10000')]), tips)).toBeNull();
    expect(tipIn(tx([xfer('USER', t0!, '0')]), tips)).toBeNull();
    expect(tipIn(tx([{ program: 'spl-token', parsed: { type: 'transfer', info: { source: 'A', destination: t0, amount: '9' } } }]), tips)).toBeNull();
  });
});

describe('bundleOf: what the explorer says, and what it cannot say', () => {
  const fresh = NOW - 3_600;
  const now = () => NOW;
  it('reports the bundle a transaction landed in', async () => {
    const f = explorer({ SIG: json(200, [{ bundle_id: BUNDLE }]) });
    expect(await bundleOf('SIG', fresh, { fetch: f, now })).toEqual({ status: 'bundled', bundleId: BUNDLE });
  });
  it('reports a recent transaction the explorer has no bundle for as not bundled', async () => {
    expect(await bundleOf('OTHER', fresh, { fetch: explorer({}), now })).toEqual({ status: 'not-bundled' });
  });
  it('never calls an old transaction not bundled: the explorer would have no record either way', async () => {
    const calls: string[] = [];
    const r = await bundleOf('OLD', NOW - EXPLORER_RETENTION_SECS - 1, { fetch: explorer({}, calls), now });
    expect(r.status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });
  it('treats a missing block time, a rate limit, a network error, a bad body and a malformed id as unknown', async () => {
    expect((await bundleOf('OTHER', null, { fetch: explorer({}), now })).status).toBe('unknown');
    expect(await bundleOf('S', fresh, { fetch: explorer({ S: json(429, { error: 'slow down' }) }), now })).toMatchObject({ status: 'unknown', why: expect.stringMatching(/rate limiting/) });
    expect(await bundleOf('S', fresh, { fetch: (async () => { throw new Error('socket hang up'); }) as typeof fetch, now })).toMatchObject({ status: 'unknown', why: expect.stringMatching(/socket hang up/) });
    expect((await bundleOf('S', fresh, { fetch: explorer({ S: new Response('<html>', { status: 200 }) }), now })).status).toBe('unknown');
    expect((await bundleOf('S', fresh, { fetch: explorer({ S: json(200, [{ bundle_id: 'not-a-hash' }]) }), now })).status).toBe('unknown');
    expect((await bundleOf('S', fresh, { fetch: explorer({ S: json(200, []) }), now })).status).toBe('unknown');
  });
});

// A scripted chain: each order account has one placing transaction.
function scriptedOrders(placements: Record<string, { sig: string; slot: number; blockTime?: number | null; err?: unknown }[]>, txs: Record<string, ParsedTransaction> = {}): RpcLike {
  return {
    async call<T>(method: string, params: unknown[] = []) {
      if (method === 'getTransaction') return (txs[params[0] as string] ?? null) as T;
      if (method !== 'getSignaturesForAddress') throw new Error(`unexpected ${method}`);
      const rows = placements[params[0] as string];
      if (!rows) throw new Error('no such account');
      return rows.map((r) => ({ signature: r.sig, slot: r.slot, err: r.err ?? null, blockTime: r.blockTime === undefined ? NOW - 600 : r.blockTime })) as T;
    },
  };
}

describe('coordinationLinks', () => {
  it('links owners whose orders landed in one bundle or one transaction, and says what it could not check', async () => {
    const rpc = scriptedOrders({
      oA: [{ sig: 'tA', slot: 10 }],
      oB: [{ sig: 'tB', slot: 10 }],
      oC: [{ sig: 'tC', slot: 11 }],
      oD: [{ sig: 'tD', slot: 12 }],
      oE: [{ sig: 'tD', slot: 12 }], // one transaction placed both orders
      oF: [{ sig: 'tF', slot: 13, blockTime: NOW - EXPLORER_RETENTION_SECS - 100 }], // too old for the explorer
      oG: [{ sig: 'tOld', slot: 1, err: { InstructionError: [0, 'x'] } }, { sig: 'tG', slot: 1 }].reverse(),
    });
    const f = explorer({ tA: json(200, [{ bundle_id: BUNDLE }]), tB: json(200, [{ bundle_id: BUNDLE }]), tG: json(200, [{ bundle_id: 'a'.repeat(64) }]) }, [], { [BUNDLE]: detail(BUNDLE, ['A']) });
    const r = await coordinationLinks(
      rpc,
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((o) => ({ owner: o, orderAddress: `o${o}` })),
      { fetch: f, now: () => NOW },
    );
    expect(r.links.map((l) => `${l.kind}:${l.a}-${l.b}`).sort()).toEqual(['same-bundle:A-B', 'same-transaction:D-E']);
    expect(r.weakLinks).toEqual([]);
    expect(r.coordinated.sort()).toEqual(['A', 'B', 'D', 'E']);
    expect(r.bundled).toBe(2); // A and B are bundled
    expect(r.notBundled).toBe(3); // C, D and E were seen recently and are in no bundle
    expect(r.unknown.count).toBe(3); // F is too old, G is in a bundle whose details cannot be read, H has no account
    expect(r.unknown.reasons.join(' ')).toMatch(/seven days/);
  });

  it('a bundle tipped by somebody who bid nothing is reported but never becomes a link', async () => {
    const rpc = scriptedOrders({ oA: [{ sig: 'tA', slot: 10 }], oB: [{ sig: 'tB', slot: 10 }] });
    const f = explorer({ tA: json(200, [{ bundle_id: BUNDLE }]), tB: json(200, [{ bundle_id: BUNDLE }]) }, [], { [BUNDLE]: detail(BUNDLE, ['SOME_RELAY']) });
    const r = await coordinationLinks(rpc, [{ owner: 'A', orderAddress: 'oA' }, { owner: 'B', orderAddress: 'oB' }], { fetch: f, now: () => NOW });
    expect(r.links).toEqual([]);
    expect(r.coordinated).toEqual([]);
    expect(r.weakLinks).toHaveLength(1);
    expect(r.weakLinks[0]).toMatchObject({ kind: 'bundle-by-third-party', why: expect.stringContaining('SOME_RELAY') });
  });
  it('reads who paid the tip from the transactions: a relay is the listed tipper while a bidder pays the lamports', async () => {
    const tip = (await jitoTipAccounts())[0]!;
    const paid = (from: string): ParsedTransaction => ({ blockTime: NOW, meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: from, destination: tip, lamports: '812025' } } }] } } });
    const rpc = scriptedOrders({ oA: [{ sig: 'tA', slot: 10 }], oB: [{ sig: 'tB', slot: 10 }] }, { tA: paid('B') });
    const f = explorer({ tA: json(200, [{ bundle_id: BUNDLE }]), tB: json(200, [{ bundle_id: BUNDLE }]) }, [], { [BUNDLE]: detail(BUNDLE, ['SOME_RELAY'], ['tA', 'tB']) });
    const r = await coordinationLinks(rpc, [{ owner: 'A', orderAddress: 'oA' }, { owner: 'B', orderAddress: 'oB' }], { fetch: f, now: () => NOW });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ kind: 'same-bundle', why: expect.stringContaining('B paid') });
    expect(r.weakLinks).toEqual([]);
  });
  it('an unreadable bundle detail is not used as a link either', async () => {
    const rpc = scriptedOrders({ oA: [{ sig: 'tA', slot: 10 }], oB: [{ sig: 'tB', slot: 10 }] });
    const f = explorer({ tA: json(200, [{ bundle_id: BUNDLE }]), tB: json(200, [{ bundle_id: BUNDLE }]) });
    const r = await coordinationLinks(rpc, [{ owner: 'A', orderAddress: 'oA' }, { owner: 'B', orderAddress: 'oB' }], { fetch: f, now: () => NOW });
    expect(r.links).toEqual([]);
    expect(r.weakLinks).toEqual([]);
    expect(r.unknown.reasons.join(' ')).toMatch(/could not be read/);
  });
  it('does not link an owner to itself, and does not duplicate a link', async () => {
    const rpc = scriptedOrders({ o1: [{ sig: 't1', slot: 1 }], o2: [{ sig: 't2', slot: 1 }], o3: [{ sig: 't1', slot: 1 }] });
    const f = explorer({ t1: json(200, [{ bundle_id: BUNDLE }]), t2: json(200, [{ bundle_id: BUNDLE }]) }, [], { [BUNDLE]: detail(BUNDLE, ['Y']) });
    const r = await coordinationLinks(rpc, [{ owner: 'X', orderAddress: 'o1' }, { owner: 'X', orderAddress: 'o3' }, { owner: 'Y', orderAddress: 'o2' }], { fetch: f, now: () => NOW });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ kind: 'same-bundle', a: 'X', b: 'Y' });
  });
});

describe('the placement store keeps final answers past the explorer window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-place-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const orders = [{ owner: 'A', orderAddress: 'oA' }, { owner: 'B', orderAddress: 'oB' }, { owner: 'C', orderAddress: 'oC' }];
  const rpc = scriptedOrders({ oA: [{ sig: 'tA', slot: 10 }], oB: [{ sig: 'tB', slot: 10 }], oC: [{ sig: 'tC', slot: 10 }] });
  const table = { tA: json(200, [{ bundle_id: BUNDLE }]), tB: json(200, [{ bundle_id: BUNDLE }]) };
  const bundles = { [BUNDLE]: detail(BUNDLE, ['A'], ['tA', 'tB']) };

  it('a second run answers from the file and makes no explorer call, even after the window has passed', async () => {
    const path = join(dir, 'p', 'placements.jsonl');
    const calls: string[] = [];
    const first = await coordinationLinks(rpc, orders, { fetch: explorer(table, calls, bundles), now: () => NOW }, new FilePlacementStore(path));
    expect(first.links).toHaveLength(1);
    expect(first.notBundled).toBe(1);
    expect(first.fromStore).toBe(0);
    const later = NOW + 30 * 86_400;
    const calls2: string[] = [];
    const second = await coordinationLinks(rpc, orders, { fetch: explorer(table, calls2, bundles), now: () => later }, new FilePlacementStore(path));
    expect(calls2).toHaveLength(0);
    expect(second.fromStore).toBe(3);
    expect(second.links).toEqual(first.links);
    expect(second.unknown.count).toBe(0);
  });
  it('never stores an unknown answer, so the next run asks again', async () => {
    const store = new MemoryPlacementStore();
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    const r1 = await coordinationLinks(rpc, orders, { fetch: down, now: () => NOW }, store);
    expect(r1.unknown.count).toBe(3);
    expect(store.get('oA')).toBeNull();
    const r2 = await coordinationLinks(rpc, orders, { fetch: explorer(table, [], bundles), now: () => NOW }, store);
    expect(r2.unknown.count).toBe(0);
    expect(store.get('oA')).not.toBeNull();
  });
  it('skips a torn line when loading', () => {
    const path = join(dir, 'q', 'placements.jsonl');
    new FilePlacementStore(path);
    writeFileSync(path, `{"orderAddress":"oX","owner":"X","signature":"s","slot":1,"blockTime":1,"bundle":{"status":"not-bundled"}}
{"orderAdd`);
    const s = new FilePlacementStore(path);
    expect(s.skippedLines).toBe(1);
    expect(s.get('oX')).not.toBeNull();
  });
});

describe('wash injection through Jito bundles: sybils that no funding trace can link', () => {
  const PARTIES = { address: 'CROSS', creator: 'CREATOR', proceedsTo: 'CREATOR', integrator: 'INTEG', feeRecipient: 'FEE' };
  const fund = (wallet: string, funder: string): Funding => ({ wallet, funder, lamports: 1_000_000n, signature: `s-${wallet}`, blockTime: 1 });
  const build = () => {
    const orders: OrderFacts[] = [];
    const fundings = new Map<string, Funding>();
    for (let i = 0; i < 20; i++) {
      const o = `HONEST${i}`;
      orders.push({ owner: o, side: i % 2 ? 'sell' : 'buy', weight: 100n });
      fundings.set(o, fund(o, `HF${i}`));
    }
    // Four sybils, each funded by a different wallet (so a funding trace finds nothing) and bidding on both sides.
    for (let i = 0; i < 4; i++) {
      const o = `SYBIL${i}`;
      orders.push({ owner: o, side: i % 2 ? 'sell' : 'buy', weight: 500n });
      fundings.set(o, fund(o, `SF${i}`));
    }
    return { orders, fundings };
  };
  const measure = (links: { a: string; b: string; why: string }[]) => {
    const { orders, fundings } = build();
    const conflicts = findConflicts({ parties: PARTIES, orders, fundings });
    const clusters = clusterByFunding([...fundings.values()], { extraLinks: links });
    return organicVolume(orders, conflicts, clusters, fundings);
  };
  const sybilLinks = [1, 2, 3].map((i) => ({ a: 'SYBIL0', b: `SYBIL${i}`, why: `orders were placed in Jito bundle ${BUNDLE}` }));

  it('without bundle evidence the sybils look independent', () => {
    const r = measure([]);
    expect(r.lowerBps).toBe(10_000);
    expect(r.crossSideClusters).toHaveLength(0);
  });
  it('with it, both bounds fall, the group counts once, and the self-trade is named', () => {
    const r = measure(sybilLinks);
    expect(r.crossSideClusters).toHaveLength(1);
    expect(r.crossSideClusters[0]).toMatchObject({ buy: 1000n, sell: 1000n, potentialSelfTrade: 1000n });
    expect(r.volume.crossSideSelfTrade).toBe(2000n);
    expect(r.lowerBps).toBe(5000); // 2000 of 4000 is independent
    expect(r.upperBps).toBe(5000);
    expect(r.breadth.independentGroups).toBe(21);
    expect(r.perOwner.SYBIL2).toBe('cross-side-cluster');
  });
  it('a wallet that is only in a bundle link, with no funding record, still joins the cluster', () => {
    const clusters = clusterByFunding([], { extraLinks: [{ a: 'P', b: 'Q', why: 'same bundle' }] });
    expect(clusters.clusters).toHaveLength(1);
    expect(clusters.clusters[0]!.members.sort()).toEqual(['P', 'Q']);
  });
  it('states in the report that the bundle check was made and how much it covered', () => {
    const { orders, fundings } = build();
    const conflicts = findConflicts({ parties: PARTIES, orders, fundings });
    const coordination = { placements: [], links: [], weakLinks: [], coordinated: [], unknown: { count: 0, reasons: [] }, notBundled: 0, bundled: 0, fromStore: 0 };
    const r = organicVolume(orders, conflicts, clusterByFunding([...fundings.values()]), fundings, coordination);
    expect(r.coordination).toBeDefined();
    expect(r.barsUnmet[0]).toMatch(/Jito bundle evidence covers/);
  });
});

describe('organicGuard', () => {
  const PARTIES = { address: 'CROSS', creator: 'CREATOR', proceedsTo: 'CREATOR', integrator: 'INTEG', feeRecipient: 'FEE' };
  const fund = (wallet: string, funder: string | null): Funding => ({ wallet, funder, lamports: funder ? 1n : null, signature: funder ? 's' : null, blockTime: 1, ...(funder ? {} : { unknown: 'no-inbound-transfer' as const }) });
  const run = (n: { independent: number; sybils?: number; issuer?: number; untraced?: number }) => {
    const orders: OrderFacts[] = [];
    const fundings = new Map<string, Funding>();
    for (let i = 0; i < n.independent; i++) {
      orders.push({ owner: `I${i}`, side: i % 2 ? 'sell' : 'buy', weight: 100n });
      fundings.set(`I${i}`, fund(`I${i}`, `F${i}`));
    }
    for (let i = 0; i < (n.sybils ?? 0); i++) {
      orders.push({ owner: `S${i}`, side: i % 2 ? 'sell' : 'buy', weight: 100n });
      fundings.set(`S${i}`, fund(`S${i}`, 'SYBILF'));
    }
    for (let i = 0; i < (n.issuer ?? 0); i++) {
      orders.push({ owner: 'CREATOR', side: 'buy', weight: 100n });
      fundings.set('CREATOR', fund('CREATOR', 'CF'));
    }
    for (let i = 0; i < (n.untraced ?? 0); i++) {
      orders.push({ owner: `U${i}`, side: 'buy', weight: 100n });
      fundings.set(`U${i}`, fund(`U${i}`, null));
    }
    const conflicts = findConflicts({ parties: PARTIES, orders, fundings });
    const report = organicVolume(orders, conflicts, clusterByFunding([...fundings.values()]), fundings);
    return { report, count: orders.length };
  };

  it('passes a broad independent population and attests the lower bound only', () => {
    const { report, count } = run({ independent: 30 });
    const g = organicGuard(report, count);
    expect(g.decision).toBe('pass');
    expect(g.attestableBase).toBe(3000n);
    expect(g.reasons[0]!.code).toBe('MEETS_BAR');
    expect(organicTier(g)).toBe('A');
  });
  it('attests the lower bound, not the upper: a passing cross with unproven volume attests less than its total', () => {
    const { report, count } = run({ independent: 30, untraced: 3 });
    const g = organicGuard(report, count);
    expect(g.decision).toBe('pass');
    expect(report.total).toBe(3300n);
    expect(g.attestableBase).toBe(3000n);
  });
  it('fails, and attests nothing, when too much volume is shown inorganic', () => {
    const { report, count } = run({ independent: 20, issuer: 6 });
    const g = organicGuard(report, count);
    expect(g.decision).toBe('fail');
    expect(g.attestableBase).toBe(0n);
    expect(g.reasons[0]!.code).toBe('INORGANIC_SHARE');
  });
  it('fails a cross-side group the same way', () => {
    const { report, count } = run({ independent: 20, sybils: 8 });
    expect(organicGuard(report, count).decision).toBe('fail');
  });
  it('holds, not fails, when the lower bound is short only because wallets are untraced', () => {
    const { report, count } = run({ independent: 10, untraced: 20 });
    const g = organicGuard(report, count);
    expect(g.decision).toBe('hold');
    expect(g.attestableBase).toBe(0n);
    expect(g.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['LOWER_BOUND_SHORT', 'MUCH_UNPROVEN']));
  });
  it('holds a thin cross, a cross with few groups, and a cross with no volume', () => {
    const thin = run({ independent: 4 });
    expect(organicGuard(thin.report, thin.count).reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['THIN_CROSS', 'FEW_INDEPENDENT_GROUPS']));
    const empty = organicVolume([], findConflicts({ parties: PARTIES, orders: [], fundings: new Map() }), clusterByFunding([]), new Map());
    expect(organicGuard(empty, 0)).toMatchObject({ decision: 'hold', reasons: [{ code: 'NO_VOLUME' }] });
  });
  it('holds when too many placements could not be checked for bundle links, and ignores that when no check was made', () => {
    const { report, count } = run({ independent: 30 });
    const unchecked = { placements: Array.from({ length: 30 }, () => ({}) as never), links: [], weakLinks: [], coordinated: [], unknown: { count: 20, reasons: ['older than the explorer keeps'] }, notBundled: 10, bundled: 0, fromStore: 0 };
    const g = organicGuard(report, count, DEFAULT_ORGANIC_POLICY, unchecked);
    expect(g.decision).toBe('hold');
    expect(g.reasons[0]!.code).toBe('PLACEMENTS_UNCHECKED');
    expect(g.basis.uncheckedPlacementsBps).toBe(6666);
    expect(organicGuard(report, count).decision).toBe('pass');
  });
  it('quoteVolume rounds down so a figure never overstates, and refuses a zero scale', () => {
    expect(quoteVolume(1_000_000n, 1_550_000n, 1_000_000_000n)).toBe(1_550n);
    expect(quoteVolume(1n, 1n, 3n)).toBe(0n);
    expect(() => quoteVolume(1n, 1n, 0n)).toThrow(RangeError);
  });
});

describe('pacedRpc', () => {
  const clock = () => {
    let t = 0;
    const sleeps: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, at: () => t };
  };
  it('spaces calls, including calls made at the same time', async () => {
    const c = clock();
    const starts: number[] = [];
    const rpc = pacedRpc({ async call() { starts.push(c.at()); return 1 as never; } }, { minIntervalMs: 100, now: c.now, sleep: c.sleep });
    await Promise.all([rpc.call('a'), rpc.call('b'), rpc.call('c')]);
    expect(starts).toEqual([0, 100, 200]);
  });
  it('retries a rate limit with a growing wait, then returns the answer', async () => {
    const c = clock();
    let n = 0;
    const retries: number[] = [];
    const rpc = pacedRpc(
      { async call() { if (++n < 4) throw new Error('getSignaturesForAddress: no endpoint could answer (api: rate limited)'); return 'ok' as never; } },
      { minIntervalMs: 0, backoffMs: 500, now: c.now, sleep: c.sleep, onRetry: (i) => retries.push(i.waitMs) },
    );
    expect(await rpc.call('x')).toBe('ok');
    expect(retries).toEqual([500, 1000, 2000]);
  });
  it('does not retry an error waiting cannot fix, and gives up after the retries', async () => {
    const c = clock();
    let n = 0;
    const bad = pacedRpc({ async call() { n++; throw new Error('Invalid param: WrongSize'); } }, { now: c.now, sleep: c.sleep });
    await expect(bad.call('x')).rejects.toThrow(/WrongSize/);
    expect(n).toBe(1);
    n = 0;
    const down = pacedRpc({ async call() { n++; throw new Error('HTTP 503'); } }, { retries: 2, now: c.now, sleep: c.sleep, backoffMs: 1 });
    await expect(down.call('x')).rejects.toThrow(/503/);
    expect(n).toBe(3);
  });
});

describe('FileFundingCache and traceWallets: a trace that resumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-trace-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A chain where every wallet has one transaction: its funding.
  const chain = (calls: { n: number }, failing: ReadonlySet<string> = new Set()): RpcLike => ({
    async call<T>(method: string, params: unknown[] = []) {
      calls.n++;
      if (method === 'getSignaturesForAddress') {
        const wallet = params[0] as string;
        if (failing.has(wallet)) throw new Error('getSignaturesForAddress: no endpoint could answer (api: rate limited)');
        return [{ signature: `sig-${wallet}`, err: null }] as T;
      }
      const sig = params[0] as string;
      const wallet = sig.slice(4);
      return { blockTime: 1, meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: `FUNDER-${wallet}`, destination: wallet, lamports: '5000' } } }] } } } as T;
    },
  });

  it('writes each funding as it is found and a second run makes no calls for them', async () => {
    const path = join(dir, 'a', 'funding.jsonl');
    const calls = { n: 0 };
    const wallets = ['w1', 'w2', 'w3'];
    const first = await traceWallets(chain(calls), wallets, { cache: new FileFundingCache(path), concurrency: 2 });
    expect(first.complete).toBe(true);
    expect(first.funded).toBe(3);
    expect(first.fundings.get('w2')).toMatchObject({ funder: 'FUNDER-w2', lamports: 5000n });
    const made = calls.n;
    expect(made).toBe(6);
    const second = await traceWallets(chain(calls), wallets, { cache: new FileFundingCache(path) });
    expect(calls.n).toBe(made);
    expect(second.fromCache).toBe(3);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('leaves a wallet it could not read untraced, completes the rest, and finishes it on the next run', async () => {
    const path = join(dir, 'b', 'funding.jsonl');
    const calls = { n: 0 };
    const cache = new FileFundingCache(path);
    const r1 = await traceWallets(chain(calls, new Set(['w2'])), ['w1', 'w2', 'w3'], { cache });
    expect(r1.complete).toBe(false);
    expect(r1.untraced.map((u) => u.wallet)).toEqual(['w2']);
    expect(r1.untraced[0]!.why).toMatch(/rate limited/);
    expect(r1.fundings.has('w2')).toBe(false);
    const r2 = await traceWallets(chain(calls), ['w1', 'w2', 'w3'], { cache: new FileFundingCache(path) });
    expect(r2.complete).toBe(true);
    expect(r2.fromCache).toBe(2);
  });

  it('stops starting wallets when the time budget is spent and says so', async () => {
    let t = 0;
    const r = await traceWallets(chain({ n: 0 }), ['a', 'b', 'c', 'd'], { cache: new MemoryFundingCache(), concurrency: 1, budgetMs: 10, now: () => (t += 6) });
    expect(r.complete).toBe(false);
    expect(r.untraced.every((u) => /time budget/.test(u.why))).toBe(true);
    expect(r.fundings.size + r.untraced.length).toBe(4);
  });

  it('survives a cache file with a torn last line', () => {
    const path = join(dir, 'c', 'funding.jsonl');
    new FileFundingCache(path);
    writeFileSync(path, `${JSON.stringify({ wallet: 'ok', funder: 'F', lamports: '1', signature: 's', blockTime: 1 })}\n{"wallet":"torn","fun`);
    const c = new FileFundingCache(path);
    expect(c.skippedLines).toBe(1);
    appendFileSync(path, '\n');
  });
});

describe('traceFunding: deeper reads and the ascending fast path', () => {
  const xfer = (w: string) => ({ program: 'system', parsed: { type: 'transfer', info: { source: `F-${w}`, destination: w, lamports: '7' } } });
  it('reads a wallet again when "history too long" was found with fewer pages than this run allows', async () => {
    const cache = new MemoryFundingCache();
    let pages = 0;
    // 5 pages of 2 signatures: the first read (3 pages) cannot reach the start, a deeper one can.
    const rpc: RpcLike = {
      async call<T>(method: string, params: unknown[] = []) {
        if (method === 'getSignaturesForAddress') {
          const before = (params[1] as { before?: string }).before;
          const page = before ? Number(before.slice(1)) + 1 : 0;
          pages++;
          return (page < 4 ? [{ signature: `p${page}a`, err: null }, { signature: `p${page}`, err: null }] : [{ signature: 'first', err: null }]) as T;
        }
        return { blockTime: 1, meta: { err: null }, transaction: { message: { instructions: [xfer('W')] } } } as T;
      },
    };
    const { traceFunding } = await import('../src/index.js');
    const shallow = await traceFunding(rpc, 'W', { pageSize: 2, maxPages: 3, cache });
    expect(shallow).toMatchObject({ unknown: 'history-too-long', pagesTried: 3 });
    const again = await traceFunding(rpc, 'W', { pageSize: 2, maxPages: 3, cache });
    expect(again).toBe(shallow); // same depth: still the cached answer
    const calls = pages;
    const deep = await traceFunding(rpc, 'W', { pageSize: 2, maxPages: 10, cache });
    expect(pages).toBeGreaterThan(calls);
    expect(deep).toMatchObject({ funder: 'F-W', signature: 'first' });
  });
  it('the ascending path uses one call, and falls back to paging when the method is not offered', async () => {
    const { traceFunding } = await import('../src/index.js');
    const row = { blockTime: 9, meta: { err: null }, transaction: { signatures: ['sigA'], message: { instructions: [xfer('W')] } } };
    const fast: RpcLike = { async call<T>(m: string) { if (m !== 'getTransactionsForAddress') throw new Error('unexpected'); return { data: [row] } as T; } };
    expect(await traceFunding(fast, 'W', { ascending: true })).toMatchObject({ funder: 'F-W', signature: 'sigA', blockTime: 9 });
    const empty: RpcLike = { async call<T>() { return { data: [] } as T; } };
    expect(await traceFunding(empty, 'W', { ascending: true })).toMatchObject({ unknown: 'no-history' });
    const calls: string[] = [];
    const slow: RpcLike = {
      async call<T>(m: string) {
        calls.push(m);
        if (m === 'getTransactionsForAddress') throw new Error('Method not found');
        if (m === 'getSignaturesForAddress') return [{ signature: 's1', err: null }] as T;
        return { blockTime: 1, meta: { err: null }, transaction: { message: { instructions: [xfer('W')] } } } as T;
      },
    };
    expect(await traceFunding(slow, 'W', { ascending: true })).toMatchObject({ funder: 'F-W', signature: 's1' });
    expect(calls).toEqual(['getTransactionsForAddress', 'getSignaturesForAddress', 'getTransaction']);
  });
});

describe('fundingBursts', () => {
  const f = (wallet: string, funder: string, t: number, lamports = 1_000_000_000n): Funding => ({ wallet, funder, lamports, signature: 's', blockTime: t });
  it('finds wallets funded the same amount by different funders inside a window (the shape seen on a real token)', async () => {
    const { fundingBursts } = await import('../src/index.js');
    // Times and amounts from the mainnet run of 2026-10-14: seven traced holders, 1 SOL each, from seven different funders, within 216 seconds.
    const t0 = Date.UTC(2026, 9, 14, 17, 50, 6) / 1000;
    const real = [f('A6', 'F1', t0 + 10), f('8Z', 'F2', t0 - 156), f('5x', 'F3', t0 + 30), f('HQ', 'F4', t0 + 43), f('F8', 'F5', t0 + 38), f('7v', 'F6', t0), f('8S', 'F7', t0 + 60)];
    const [b] = fundingBursts(real);
    expect(b!.wallets).toHaveLength(7);
    expect(b!.funders).toHaveLength(7);
    expect(b!.spanSecs).toBe(216);
  });
  it('ignores a single funder (already a cluster), different amounts, a spread-out set and too few wallets', async () => {
    const { fundingBursts } = await import('../src/index.js');
    expect(fundingBursts([f('a', 'X', 1), f('b', 'X', 2), f('c', 'X', 3), f('d', 'X', 4)])).toEqual([]);
    expect(fundingBursts([f('a', 'A', 1, 1n), f('b', 'B', 2, 2n), f('c', 'C', 3, 3n), f('d', 'D', 4, 4n)])).toEqual([]);
    expect(fundingBursts([f('a', 'A', 0), f('b', 'B', 1000), f('c', 'C', 2000), f('d', 'D', 3000)])).toEqual([]);
    expect(fundingBursts([f('a', 'A', 1), f('b', 'B', 2), f('c', 'C', 3)])).toEqual([]);
  });
});

describe('parseClaims reads each count as the thing it counts', () => {
  it('"N orders carry a conflict flag" is about flagged orders, not total orders', async () => {
    const { parseClaims } = await import('../src/index.js');
    expect(parseClaims('23 orders carry a conflict flag, 91.99% of known volume.').claims).toEqual([expect.objectContaining({ metric: 'conflicts.flaggedOrders', value: '23' })]);
    expect(parseClaims('The cross has 1,200 orders.').claims).toEqual([expect.objectContaining({ metric: 'cross.ordersTotal', value: '1200' })]);
  });
});
