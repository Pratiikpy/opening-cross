// The organic-volume attester: configuration, the decision of what to state, and whole passes against an in-memory chain, order list and Jito explorer.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, generateKeyPairSigner } from '@solana/kit';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, ROUND_DISCRIMINATOR, getPostVolumeInstructionDataDecoder, getRoundDecoder, getRoundEncoder } from '@opening-cross/cross-graduate-client';
import { MemoryFundingCache, MemoryPlacementStore, type RpcLike } from '@opening-cross/integrity';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder, getCrossEncoder, roundAddress } from '@opening-cross/sdk';
import { ConfigError, parseConfig, planVolume, volumeOnce, type VolumeConfig } from '../src/index.js';

const NOW = 1_800_000_000;
const BUNDLE = 'd'.repeat(64);
const key = async () => (await generateKeyPairSigner()).address;

describe('configuration', () => {
  const ok = { apiBase: 'https://api.example.org/', stateDir: '/tmp/s', crosses: ['11111111111111111111111111111112'] };
  it('fills defaults, keeps the guard policy named, and says when the operator changed it', () => {
    const c = parseConfig(ok);
    expect(c).toMatchObject({ apiBase: 'https://api.example.org', bundles: true, minChangeBps: 100, maxIncreaseFactor: 4, traceBudgetSecs: 120 });
    expect(c.policy.version).toBe('ovs-guard-v0-unfitted');
    expect(parseConfig({ ...ok, policy: { minLowerBps: 7000 } }).policy).toMatchObject({ minLowerBps: 7000, version: 'ovs-guard-v0-unfitted+operator' });
  });
  it('refuses what could make it state something untrue', () => {
    const bad = (c: unknown, m: RegExp) => expect(() => parseConfig(c), JSON.stringify(c)).toThrow(m);
    bad('x', /must be an object/);
    bad({ ...ok, extra: 1 }, /unknown field extra/);
    bad({ ...ok, apiBase: 'http://api.example.org' }, /must be https/);
    bad({ ...ok, apiBase: 'nope' }, /not a URL/);
    bad({ ...ok, crosses: [] }, /at least one cross/);
    bad({ ...ok, crosses: ['nope'] }, /base58/);
    bad({ ...ok, crosses: [ok.crosses[0], ok.crosses[0]] }, /twice/);
    bad({ ...ok, stateDir: '' }, /directory/);
    bad({ ...ok, policy: { minLowerBpz: 1 } }, /unknown policy field/);
    bad({ ...ok, policy: { minLowerBps: -1 } }, /from 0 to/);
    bad({ ...ok, bundles: 'yes' }, /true or false/);
    expect(() => parseConfig('x')).toThrow(ConfigError);
    expect(parseConfig({ ...ok, apiBase: 'http://127.0.0.1:9', allowInsecure: true }).apiBase).toBe('http://127.0.0.1:9');
  });
});

describe('planVolume', () => {
  const c = { minChangeBps: 100, maxIncreaseFactor: 4 };
  const signer = 'SIGNER' as Address;
  const round = (o: Partial<{ volumeAttester: Address | null; finalized: boolean; volumeSet: boolean; volumeQuote: bigint }> = {}) => ({ volumeAttester: signer, finalized: false, volumeSet: false, volumeQuote: 0n, ...o });
  const g = (decision: 'pass' | 'hold' | 'fail') => ({ decision, reasons: [{ code: 'MEETS_BAR' as const, message: decision }] });
  it('states a first figure, lowers at once, raises only by a meaningful step, and holds a jump', () => {
    expect(planVolume({ signer, round: round(), guard: g('pass'), lowerQuote: 500n }, c)).toEqual({ post: true, volume: 500n, reason: 'FIRST_STATEMENT' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 500n }), guard: g('pass'), lowerQuote: 499n }, c)).toMatchObject({ post: true, volume: 499n, reason: 'LOWERED' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 10_000n }), guard: g('pass'), lowerQuote: 10_050n }, c)).toMatchObject({ post: false, reason: 'UNCHANGED' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 10_000n }), guard: g('pass'), lowerQuote: 10_100n }, c)).toMatchObject({ post: true, reason: 'CHANGED' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 10_000n }), guard: g('pass'), lowerQuote: 10_000n }, c)).toMatchObject({ post: false, reason: 'UNCHANGED' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 100n }), guard: g('pass'), lowerQuote: 1_000n }, c)).toMatchObject({ post: false, reason: 'JUMP_TOO_LARGE' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 100n }), guard: g('pass'), lowerQuote: 1_000n }, { ...c, maxIncreaseFactor: 0 })).toMatchObject({ post: true });
  });
  it('withdraws a stated figure when the guard fails, and says nothing when there was none or the evidence is incomplete', () => {
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 900n }), guard: g('fail'), lowerQuote: 0n }, c)).toEqual({ post: true, volume: 0n, reason: 'RETRACTED' });
    expect(planVolume({ signer, round: round(), guard: g('fail'), lowerQuote: 0n }, c)).toMatchObject({ post: false, reason: 'FAILED_NOTHING_POSTED' });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 0n }), guard: g('fail'), lowerQuote: 0n }, c)).toMatchObject({ post: false });
    expect(planVolume({ signer, round: round({ volumeSet: true, volumeQuote: 900n }), guard: g('hold'), lowerQuote: 0n }, c)).toMatchObject({ post: false, reason: 'HELD' });
  });
  it('is not for another key or a finished round', () => {
    expect(planVolume({ signer, round: round({ volumeAttester: 'OTHER' as Address }), guard: g('pass'), lowerQuote: 1n }, c)).toMatchObject({ reason: 'NOT_OUR_ROUND' });
    expect(planVolume({ signer, round: round({ finalized: true }), guard: g('pass'), lowerQuote: 1n }, c)).toMatchObject({ reason: 'ROUND_FINALIZED' });
  });
});

// ------------------------------------------------------------------------------------------------ whole passes

type Setup = { honest?: number; sybils?: number; attesterIsUs?: boolean; posted?: bigint; apiDown?: boolean; clearing?: boolean; flaky?: RegExp };

async function world(s: Setup = {}) {
  const signer = await generateKeyPairSigner();
  const cross = await key();
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  const creator = await key();
  accounts.set(cross, {
    owner: CROSS_CORE_PROGRAM_ADDRESS as Address,
    data: new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), creator, proceedsTo: creator, priceScale: 1_000_000n, clearing: s.clearing === false ? { __option: 'None' } : { __option: 'Some', value: { price: 2_000_000n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } } } as never)),
  });
  const rz = new Uint8Array(1024);
  rz.set(ROUND_DISCRIMINATOR as Uint8Array, 0);
  const roundAddr = await roundAddress(cross, 0);
  accounts.set(roundAddr, {
    owner: CROSS_GRADUATE_PROGRAM_ADDRESS as Address,
    data: new Uint8Array(getRoundEncoder().encode({ ...getRoundDecoder().decode(rz), cross, volumeAttester: { __option: 'Some', value: s.attesterIsUs === false ? await key() : signer.address }, volumeSet: s.posted !== undefined, volumeQuote: s.posted ?? 0n } as never)),
  });
  const orders: Record<string, unknown>[] = [];
  const mk = (owner: string, side: 'buy' | 'sell') => orders.push({ idx: orders.length, address: `ord-${owner}`, owner, side, status: 'claimed', quantity: '100', fill: '100' });
  for (let i = 0; i < (s.honest ?? 24); i++) mk(`H${i}`, i % 2 ? 'sell' : 'buy');
  for (let i = 0; i < (s.sybils ?? 0); i++) mk(`S${i}`, i % 2 ? 'sell' : 'buy');
  const sybilTx = Array.from({ length: s.sybils ?? 0 }, (_, i) => `place-S${i}`);
  const rpc: RpcLike = {
    async call<T>(method: string, params: unknown[] = []) {
      if (method === 'getSignaturesForAddress') {
        const a = params[0] as string;
        if (s.flaky && s.flaky.test(a)) throw new Error('no endpoint could answer (rate limited)');
        return (a.startsWith('ord-') ? [{ signature: `place-${a.slice(4)}`, slot: 5, err: null, blockTime: NOW - 60 }] : [{ signature: `fund-${a}`, slot: 1, err: null, blockTime: NOW - 86_400 }]) as T;
      }
      const sig = params[0] as string;
      if (!sig.startsWith('fund-')) return null as T;
      const w = sig.slice(5);
      return { blockTime: 1, meta: { err: null }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: `FUNDER-${w}`, destination: w, lamports: '5000' } } }] } } } as T;
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/bundles/bundle/')) return new Response(JSON.stringify([{ bundleId: BUNDLE, slot: 5, validator: 'V', tippers: ['S0'], landedTipLamports: 1, txSignatures: sybilTx }]), { status: 200 });
    const sig = url.split('/transaction/')[1]!;
    return sybilTx.includes(sig) ? new Response(JSON.stringify([{ bundle_id: BUNDLE }]), { status: 200 }) : new Response(JSON.stringify({ error: 'Bundle not found' }), { status: 400 });
  }) as typeof fetch;
  const sent: Instruction[][] = [];
  const config: VolumeConfig = parseConfig({ apiBase: 'https://api.example.org', stateDir: '/tmp/unused', crosses: [cross] });
  const deps = {
    signer,
    config,
    rpc,
    cache: new MemoryFundingCache(),
    placements: new MemoryPlacementStore(),
    account: async (a: Address) => accounts.get(a) ?? null,
    fetchJson: async (url: string) => {
      if (s.apiDown) throw new Error('connect ECONNREFUSED');
      return url.endsWith('/orders') ? { orders } : { perOwner: {} };
    },
    send: async (ixs: Instruction[]) => {
      sent.push(ixs);
      return 'SIG';
    },
  };
  return { deps, sent, cross, restore: () => (globalThis.fetch = realFetch) };
}

const volumeOf = (ix: Instruction) => getPostVolumeInstructionDataDecoder().decode(ix.data!).volumeQuote;

describe('a whole pass', () => {
  it('posts the lower bound in quote atoms for a clean population: 2400 independent base atoms at a price of 2 quote per base', async () => {
    const w = await world();
    try {
      const [o] = await volumeOnce(w.deps);
      expect(o).toMatchObject({ status: 'posted', reason: 'FIRST_STATEMENT', volumeQuote: 4_800n });
      expect(volumeOf(w.sent[0]![0]!)).toBe(4_800n);
      expect((o as { summary: { decision: string } }).summary.decision).toBe('pass');
    } finally {
      w.restore();
    }
  });
  it('plans without sending in a dry run', async () => {
    const w = await world();
    try {
      const [o] = await volumeOnce({ ...w.deps, dryRun: true });
      expect(o).toMatchObject({ status: 'planned', volumeQuote: 4_800n });
      expect(w.sent).toHaveLength(0);
    } finally {
      w.restore();
    }
  });
  it('withdraws an earlier figure when bundle evidence shows sybils on both sides that no funding trace could see', async () => {
    const w = await world({ sybils: 6, posted: 6_000n });
    try {
      const [o] = await volumeOnce(w.deps);
      expect(o).toMatchObject({ status: 'posted', reason: 'RETRACTED', volumeQuote: 0n });
      expect(volumeOf(w.sent[0]![0]!)).toBe(0n);
    } finally {
      w.restore();
    }
  });
  it('without the bundle check the same sybils are not seen, which is why the check is on by default', async () => {
    const w = await world({ sybils: 6 });
    try {
      const [o] = await volumeOnce({ ...w.deps, config: { ...w.deps.config, bundles: false } });
      expect(o).toMatchObject({ status: 'posted' });
    } finally {
      w.restore();
    }
  });
  it('holds, posting nothing, when most of the bidders cannot be traced: their volume is unknown, not independent', async () => {
    const w = await world({ honest: 24, flaky: /^H([0-9]|1[0-3])$/ });
    try {
      const [o] = await volumeOnce(w.deps);
      expect(w.sent).toHaveLength(0);
      expect(o).toMatchObject({ status: 'skipped', code: 'HELD', summary: { decision: 'hold', untraced: 14 } });
    } finally {
      w.restore();
    }
  });
  it('holds a thin cross', async () => {
    const w = await world({ honest: 6 });
    try {
      const [o] = await volumeOnce(w.deps);
      expect(w.sent).toHaveLength(0);
      expect(o).toMatchObject({ code: 'HELD', summary: { reasons: expect.arrayContaining(['THIN_CROSS']) } });
    } finally {
      w.restore();
    }
  });
  it('posts nothing when the order list or declarations cannot be read, when the round names another key, and when the cross has no price', async () => {
    for (const [s, code] of [[{ apiDown: true }, 'API_UNREADABLE'], [{ attesterIsUs: false }, 'NOT_OUR_ROUND'], [{ clearing: false }, 'NO_CLEARING']] as const) {
      const w = await world(s);
      try {
        const [o] = await volumeOnce(w.deps);
        expect(o, code).toMatchObject({ code });
        expect(w.sent).toHaveLength(0);
      } finally {
        w.restore();
      }
    }
  });
});
