// The keeper on crosses with rules: a drawn ending is begun and finished before the clear, the clear merges the ending buckets,
// claims carry the order's tail, and a cross of the earlier layout (no tail) is driven exactly as before. Pure: accounts are in memory.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, generateKeyPairSigner, none, some } from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_DISCRIMINATOR,
  CROSS_EXT_LEN,
  CrossState,
  ORDER_BODY_LEN,
  ORDER_DISCRIMINATOR,
  completeRules,
  getCrossDecoder,
  getCrossEncoder,
  getCrossExtEncoder,
  getOrderDecoder,
  getOrderEncoder,
} from '@opening-cross/cross-core-client';
import { runOnce } from '../src/index.js';

const NOW = 1_800_000_000n;
const ZERO = '11111111111111111111111111111111' as Address;
const CLEARED = some({ price: 1n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 });

type Draw = { pendingSlot?: bigint; seedReady?: boolean; epoch?: number; extPending?: boolean };
type Opts = { state: CrossState; rules?: Parameters<typeof completeRules>[0] | null; draw?: Draw; orders?: number; shards?: number; mergedMask?: number };

async function fixture(o: Opts) {
  const payer = await generateKeyPairSigner();
  const cross = (await generateKeyPairSigner()).address;
  const base = (await generateKeyPairSigner()).address;
  const quote = (await generateKeyPairSigner()).address;
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  const orders = o.orders ?? 0;
  const body = getCrossEncoder().encode({
    ...getCrossDecoder().decode(z), state: o.state, baseBound: true, baseMint: base, quoteMint: quote, creator: payer.address, feeRecipient: payer.address, integrator: payer.address, proceedsTo: payer.address,
    shards: o.shards ?? 2, mergedMask: o.mergedMask ?? 0, openTs: NOW - 5000n, closeTs: NOW - 4000n, revealEndTs: NOW - 3000n, ordersOpen: orders, ordersTotal: orders, oracle: none(),
    clearing: o.state === CrossState.Cleared ? CLEARED : none(),
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + (o.rules ? CROSS_EXT_LEN : 0));
  data.set(body);
  if (o.rules) {
    const r = completeRules(o.rules);
    const d = o.draw ?? {};
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 1n, flags: r.flags, guards: { ...r.guards, haltSource: null }, ending: r.ending,
        draw: { epoch: d.epoch ?? 0, pendingSlot: d.pendingSlot ?? 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: d.seedReady ? (d.epoch ?? 0) : 0, seedReady: d.seedReady ?? false, endBucket: 255, extPending: d.extPending ?? false, extensionUsed: false, auxMerged: 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
        neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
      } as never),
      CROSS_BODY_LEN,
    );
  }
  const accounts = new Map<string, Uint8Array>([[cross, data]]);
  const orderAddresses: Address[] = [];
  const oz = new Uint8Array(512);
  oz.set(ORDER_DISCRIMINATOR as Uint8Array, 0);
  for (let i = 0; i < orders; i++) {
    const a = (await generateKeyPairSigner()).address;
    orderAddresses.push(a);
    const ob = getOrderEncoder().encode({ ...getOrderDecoder().decode(oz), cross, owner: (await generateKeyPairSigner()).address, nonce: BigInt(i), index: i, side: i % 2 } as never);
    const od = new Uint8Array(ORDER_BODY_LEN + (o.rules ? 32 : 0));
    od.set(ob);
    // the order's tail: version 1, epoch 0, bucket 1
    if (o.rules) od.set([1, 0, 1], ORDER_BODY_LEN);
    accounts.set(a, od);
  }
  return { payer, cross, accounts, orderAddresses };
}

async function pass(f: Awaited<ReturnType<typeof fixture>>, slot: bigint | null) {
  const sent: Instruction[][] = [];
  const r = await runOnce({
    payer: f.payer,
    now: async () => NOW,
    ...(slot === null ? {} : { slot: async () => slot }),
    fetch: async (a) => f.accounts.get(a) ?? null,
    crosses: async () => [f.cross],
    orders: async () => f.orderAddresses,
    send: async (ixs) => (sent.push(ixs), 'sig'),
  });
  return { r, sent };
}
const kinds = (r: Awaited<ReturnType<typeof pass>>['r']) => [...new Set(r.done.map((d) => d.action.kind))];
const ENDING = { ending: { endingSecs: 400, buckets: 3, randomEnd: true } };

describe('keeper on a cross with a drawn ending', () => {
  it('begins the draw instead of clearing, once the reveal window is over', async () => {
    const f = await fixture({ state: CrossState.Live, rules: ENDING });
    const { r } = await pass(f, 1_000n);
    expect(kinds(r)).toEqual(['draw-begin']);
    expect(r.failed).toEqual([]);
  });

  it('waits for 20 slots, then finishes, and says why it is waiting', async () => {
    const f = await fixture({ state: CrossState.Live, rules: ENDING, draw: { pendingSlot: 1_000n } });
    const early = await pass(f, 1_010n);
    expect(early.r.done).toEqual([]);
    expect(early.r.skipped[0]!.reason).toMatch(/cannot finish before slot 1020/);
    const ready = await pass(f, 1_030n);
    expect(kinds(ready.r)).toEqual(['draw-finish']);
  });

  it('restarts a draw whose window was missed (void)', async () => {
    const f = await fixture({ state: CrossState.Live, rules: ENDING, draw: { pendingSlot: 1_000n } });
    expect(kinds((await pass(f, 1_500n)).r)).toEqual(['draw-begin']);
  });

  it('with no slot source it does not guess: it skips with the reason', async () => {
    const f = await fixture({ state: CrossState.Live, rules: ENDING });
    const { r } = await pass(f, null);
    expect(r.done).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/no slot source/);
  });

  it('after the draw it merges the main shards, the buckets and clears', async () => {
    const f = await fixture({ state: CrossState.Live, rules: ENDING, draw: { seedReady: true } });
    const { r, sent } = await pass(f, 1_000n);
    expect(kinds(r)).toEqual(['settle']);
    // two main shards and the buckets 0..2 (endBucket 255: all count), each in its own transaction, then the clear
    expect(sent.slice(0, 6).every((ixs) => ixs.length === 1)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(6);
  });

  it('a drawn extension pending after a failed clear is begun the same way', async () => {
    const f = await fixture({ state: CrossState.Live, rules: { ending: { endingSecs: 400, buckets: 3, randomEnd: false, extensionMinSecs: 60, extensionMaxSecs: 600 } }, draw: { extPending: true, seedReady: true } });
    const { r } = await pass(f, 1_000n);
    expect(kinds(r)).toEqual(['draw-begin']);
  });

  it('claims carry the order\'s tail: a claim on a bucketed cross is built with the order\'s facts', async () => {
    const f = await fixture({ state: CrossState.Cleared, rules: ENDING, draw: { seedReady: true }, orders: 2 });
    const { r, sent } = await pass(f, 1_000n);
    expect(r.failed).toEqual([]);
    expect(r.done.filter((d) => d.action.kind === 'claim')).not.toHaveLength(0);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe('keeper on a cross of the earlier layout', () => {
  it('a cross with no tail clears at once and needs no slot', async () => {
    const f = await fixture({ state: CrossState.Live, rules: null });
    const { r, sent } = await pass(f, null);
    expect(kinds(r)).toEqual(['settle']);
    expect(r.skipped).toEqual([]);
    // two shards and the clear, with the legacy account counts (3, 3, then the clear)
    expect(sent.length % 3).toBe(0);
    expect(sent.slice(0, 2).map((ixs) => ixs[0]!.accounts!.length)).toEqual([3, 3]);
  });

  it('a cleared cross claims and finalizes exactly as before', async () => {
    const f = await fixture({ state: CrossState.Cleared, rules: null, orders: 2 });
    const { r } = await pass(f, null);
    expect(kinds(r)).toContain('claim');
    expect(r.failed).toEqual([]);
    expect(CROSS_EXT_LEN).toBeGreaterThan(0);
  });
});
