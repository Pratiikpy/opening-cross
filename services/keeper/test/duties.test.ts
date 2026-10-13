// The planners of the keeper's duties, one case at a time. Pure: no chain, no clock but the one passed in.
import { describe, expect, it } from 'vitest';
import { type Address, none, some } from '@solana/kit';
import { type Cross, CrossState, type HaltState, HaltReason, type Series, SupplyMode } from '@opening-cross/cross-core-client';
import { MAX_PUSH_REFUNDS, type OpenOrder, plan, refundOnly } from '../src/plan.js';
import { ARBITER_DEADLINE_SECS, OBSERVE_MAX_AGE_SECS, planExpiries, planHalt, planRelease, planSpawn } from '../src/duties.js';

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const A = (n: number) => `Addr${n}` as unknown as Address;

const cross = (o: Partial<{ state: CrossState; price: bigint | null; ordersOpen: number; supplyMode: SupplyMode; baseBound: boolean }> = {}) =>
  ({
    state: o.state ?? CrossState.Cleared,
    supplyMode: o.supplyMode ?? SupplyMode.Escrow,
    baseBound: o.baseBound ?? true,
    ordersOpen: o.ordersOpen ?? 0,
    settleDeadlineTs: 0n,
    revealEndTs: NOW - 1n,
    clearing: o.price === null || o.state === CrossState.NoPrint ? { __option: 'None' } : { __option: 'Some', value: { price: o.price ?? 100n } },
  }) as unknown as Cross;
const order = (i: number, side: 'buy' | 'sell', price: bigint, revealed = true): OpenOrder => ({ address: A(i), owner: A(1000 + i), nonce: BigInt(i), side, price, revealed });

describe('refundOnly: exactly the orders the program refunds in full', () => {
  it('everything on a cross that did not print', () => {
    for (const side of ['buy', 'sell'] as const) expect(refundOnly(cross({ state: CrossState.NoPrint }), order(1, side, 1n))).toBe(true);
  });
  it('a sealed order that was never revealed, whatever its price', () => {
    expect(refundOnly(cross(), order(1, 'buy', 500n, false))).toBe(true);
  });
  it('a buy below the clearing price and a sell above it; not an order at the price or across it', () => {
    const c = cross({ price: 100n });
    expect(refundOnly(c, order(1, 'buy', 99n))).toBe(true);
    expect(refundOnly(c, order(2, 'sell', 101n))).toBe(true);
    expect(refundOnly(c, order(3, 'buy', 100n))).toBe(false); // marginal: it may be rationed, so the program decides
    expect(refundOnly(c, order(4, 'sell', 100n))).toBe(false);
    expect(refundOnly(c, order(5, 'buy', 101n))).toBe(false);
    expect(refundOnly(c, order(6, 'sell', 99n))).toBe(false);
  });
  it('never when the keeper lacks the facts, or the cross is live or finalized', () => {
    expect(refundOnly(cross({ price: 100n }), { address: A(1), owner: A(2), nonce: 1n })).toBe(false);
    expect(refundOnly(cross({ state: CrossState.Live }), order(1, 'buy', 1n))).toBe(false);
    expect(refundOnly(cross({ state: CrossState.Finalized }), order(1, 'buy', 1n))).toBe(false);
    expect(refundOnly(cross({ price: null }), order(1, 'buy', 1n))).toBe(false);
  });
});

describe('plan: pushed refunds', () => {
  const refunds = (n: number) => Array.from({ length: n }, (_, i) => order(i, 'buy', 50n));
  const kinds = (p: ReturnType<typeof plan>) => p.actions.map((a) => (a.kind === 'push-refunds' ? `push:${a.orders.length}` : a.kind));
  it('is off unless asked for: one claim per order', () => {
    expect(kinds(plan(A(0), cross({ ordersOpen: 3 }), refunds(3), NOW))).toEqual(['claim', 'claim', 'claim']);
  });
  it('batches refund-only orders up to the program limit, and claims a lone remainder', () => {
    const p = (n: number) => kinds(plan(A(0), cross({ ordersOpen: n }), refunds(n), NOW, { ext: null, slot: null }, { pushRefunds: true }));
    expect(p(1)).toEqual(['claim']);
    expect(p(2)).toEqual(['push:2']);
    expect(p(12)).toEqual(['push:12']);
    expect(p(13)).toEqual(['push:12', 'claim']);
    expect(p(14)).toEqual(['push:12', 'push:2']);
    expect(p(30)).toEqual(['push:12', 'push:12', 'push:6']);
    expect(MAX_PUSH_REFUNDS).toBe(12);
  });
  it('claims the orders that may have a fill, and batches only those that cannot', () => {
    const orders = [order(1, 'buy', 50n), order(2, 'buy', 120n), order(3, 'sell', 150n), order(4, 'buy', 100n), order(5, 'sell', 80n), order(6, 'buy', 10n, false)];
    const p = plan(A(0), cross({ price: 100n, ordersOpen: 6 }), orders, NOW, { ext: null, slot: null }, { pushRefunds: true });
    const push = p.actions.find((a) => a.kind === 'push-refunds');
    expect(push?.kind === 'push-refunds' && push.orders.map((o) => o.address)).toEqual([A(1), A(3), A(6)]);
    expect(p.actions.filter((a) => a.kind === 'claim').map((a) => (a.kind === 'claim' ? a.order.address : null))).toEqual([A(2), A(4), A(5)]);
  });
  it('finalizes only when no order is left open', () => {
    expect(kinds(plan(A(0), cross({ ordersOpen: 0 }), [], NOW))).toEqual(['finalize']);
    expect(kinds(plan(A(0), cross({ ordersOpen: 2 }), [], NOW)).includes('finalize')).toBe(false);
  });
});

describe('plan: finalize waits for the insider challenge window and for open challenges', () => {
  const ext = (o: { bond: bigint; open: number; clearedTs: bigint; challengeSecs: number }) =>
    ({ neutrality: { bondQuote: o.bond, challengeSecs: o.challengeSecs }, neutralState: { openChallenges: o.open }, clearing: { clearedTs: o.clearedTs } }) as never;
  it('skips with the reason while a challenge is open or the window runs, and finalizes after both', () => {
    const open = plan(A(0), cross(), [], NOW, { ext: ext({ bond: 5n, open: 1, clearedTs: NOW - 10_000n, challengeSecs: 3_600 }), slot: null });
    expect(open.actions).toEqual([]);
    expect(open.skipped[0]).toMatchObject({ code: 'CHALLENGE_OPEN' });
    const window = plan(A(0), cross(), [], NOW, { ext: ext({ bond: 5n, open: 0, clearedTs: NOW - 100n, challengeSecs: 3_600 }), slot: null });
    expect(window.skipped[0]).toMatchObject({ code: 'CHALLENGE_WINDOW' });
    expect(window.skipped[0]!.reason).toContain(String(NOW - 100n + 3_600n));
    const done = plan(A(0), cross(), [], NOW, { ext: ext({ bond: 5n, open: 0, clearedTs: NOW - 3_600n, challengeSecs: 3_600 }), slot: null });
    expect(done.actions).toEqual([{ kind: 'finalize', cross: A(0) }]);
  });
  it('a cross with no bond, or one that did not print, never waits', () => {
    expect(plan(A(0), cross(), [], NOW, { ext: ext({ bond: 0n, open: 3, clearedTs: NOW, challengeSecs: 3_600 }), slot: null }).actions).toHaveLength(1);
    expect(plan(A(0), cross({ state: CrossState.NoPrint }), [], NOW, { ext: ext({ bond: 5n, open: 3, clearedTs: NOW, challengeSecs: 3_600 }), slot: null }).actions).toHaveLength(1);
  });
});

describe('planExpiries', () => {
  const ch = (id: number, filedAgo: bigint, open = true) => ({ id, address: A(100 + id), challenger: A(200 + id), filedTs: NOW - filedAgo, open });
  it('closes a challenge exactly 14 days after it was filed, not a second before', () => {
    expect(ARBITER_DEADLINE_SECS).toBe(14n * DAY);
    expect(planExpiries(A(0), [ch(1, 14n * DAY - 1n)], NOW).actions).toEqual([]);
    expect(planExpiries(A(0), [ch(1, 14n * DAY)], NOW).actions).toEqual([{ kind: 'expire-challenge', cross: A(0), id: 1, challenge: A(101), challenger: A(201) }]);
  });
  it('closes the old ones, says when the next can be closed, and ignores closed ones', () => {
    const p = planExpiries(A(0), [ch(0, 20n * DAY), ch(1, 1n * DAY), ch(2, 30n * DAY, false)], NOW);
    expect(p.actions.map((a) => (a.kind === 'expire-challenge' ? a.id : -1))).toEqual([0]);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]).toMatchObject({ code: 'CHALLENGE_WAITING' });
    expect(p.skipped[0]!.reason).toContain(String(NOW - DAY + 14n * DAY));
    expect(planExpiries(A(0), [], NOW)).toEqual({ actions: [], skipped: [] });
  });
});

describe('planRelease', () => {
  const lock = (o: Partial<{ amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }> = {}) => ({ address: A(1), cross: A(2), owner: A(3), nonce: 4n, amount: 1_000n, released: 0n, startTs: NOW - 200n, cliffSecs: 50, vestSecs: 1_000, ...o });
  it('releases what has vested, and nothing before the cliff', () => {
    expect(planRelease(lock({ startTs: NOW - 10n }), NOW)).toBeNull();
    expect(planRelease(lock(), NOW)).toMatchObject({ kind: 'release-locked', releasable: 150n, owner: A(3), nonce: 4n });
  });
  it('waits for the threshold, except for the last release', () => {
    expect(planRelease(lock(), NOW, 200n)).toBeNull();
    expect(planRelease(lock({ released: 900n, startTs: NOW - 10_000n }), NOW, 500n)).toMatchObject({ releasable: 100n });
    expect(planRelease(lock({ released: 400n, startTs: NOW - 10_000n }), NOW, 10_000n)).toMatchObject({ releasable: 600n });
    expect(planRelease(lock({ released: 1_000n }), NOW)).toBeNull();
  });
});

describe('planSpawn', () => {
  const series = (o: { next?: bigint; start?: bigint; interval?: bigint; last?: Address; active?: boolean; max?: bigint; flags?: number } = {}) =>
    ({ active: o.active ?? true, nextIndex: o.next ?? 0n, lastCloseTs: 0n, lastCross: o.last ? { __option: 'Some', value: o.last } : { __option: 'None' }, config: { maxCrosses: o.max ?? 0n, intervalSecs: o.interval ?? 3_600n, startTs: o.start ?? NOW + 1_000n, callSecs: 600n, calendar: { __option: 'None' }, rules: { flags: o.flags ?? 0 } } }) as unknown as Series;
  it('spawns the first cross when it is within the day, with the lender feed only when the rules feed lenders', () => {
    expect(planSpawn({ address: A(1), series: series(), previous: null, sessionStarts: null }, NOW).actions).toEqual([{ kind: 'spawn-next', series: A(1), feed: false }]);
    expect(planSpawn({ address: A(1), series: series({ flags: 4 }), previous: null, sessionStarts: null }, NOW).actions).toEqual([{ kind: 'spawn-next', series: A(1), feed: true }]);
  });
  it('says why it waits: too early, previous cross live, no previous cross, no session ahead, paused, done', () => {
    const code = (s: Series, previous: Parameters<typeof planSpawn>[0]['previous'], sessions: bigint[] | null = null) => planSpawn({ address: A(1), series: s, previous, sessionStarts: sessions }, NOW).skipped[0];
    expect(code(series({ start: NOW + 3n * DAY }), null)).toMatchObject({ code: 'SERIES_WAITING' });
    expect(code(series({ next: 1n, last: A(9), start: NOW - 3_600n }), { address: A(9), state: CrossState.Live })!.reason).toMatch(/still live/);
    expect(code(series({ next: 1n, last: A(9), start: NOW - 3_600n }), null)!.reason).toMatch(/cannot be read/);
    expect(code({ ...series(), config: { ...series().config, intervalSecs: 0n } } as Series, null, [NOW - 5n])!.reason).toMatch(/no session ahead/);
    expect(code(series({ active: false }), null)).toMatchObject({ code: 'SERIES_PAUSED' });
    expect(code(series({ max: 1n, next: 1n, last: A(9) }), { address: A(9), state: CrossState.Cleared })).toMatchObject({ code: 'SERIES_DONE' });
  });
  it('on a calendar spawns for the earliest session ahead', () => {
    const s = { ...series(), config: { ...series().config, intervalSecs: 0n } } as Series;
    expect(planSpawn({ address: A(1), series: s, previous: null, sessionStarts: [NOW + 400n, NOW + 9n * DAY] }, NOW).actions).toHaveLength(1);
    expect(planSpawn({ address: A(1), series: s, previous: null, sessionStarts: [NOW + 9n * DAY] }, NOW).actions).toHaveLength(0);
  });
});

describe('planHalt', () => {
  const halt = (o: Partial<{ halted: boolean; reason: HaltReason; issuerUnpaused: boolean; corporateAction: boolean; lastPublishTs: bigint | null }> = {}) =>
    ({
      baseMint: A(5), authority: A(6), venueSigner: none(), halted: o.halted ?? false, reason: o.reason ?? HaltReason.None, corporateAction: o.corporateAction ?? false, sinceTs: NOW - 5n, issuerUnpaused: o.issuerUnpaused ?? false,
      breaker: o.lastPublishTs === null || o.lastPublishTs === undefined ? none() : some({ feedId: new Uint8Array(32), windowSlots: 10, moveBps: 500, lastPrice: 1n, lastExponent: 0, lastSlot: 1n, lastPublishTs: o.lastPublishTs }),
    }) as unknown as HaltState;
  const f = (h: HaltState, mintPaused: boolean | null, update: { account: Address; publishTime: bigint } | null = null) => ({ address: A(7), halt: h, mintPaused, update });
  it('copies a pause into the halt state once, and then says it is halted', () => {
    expect(planHalt(f(halt(), true), NOW).actions).toEqual([{ kind: 'sync-pause', halt: A(7), baseMint: A(5), because: 'paused' }]);
    const after = planHalt(f(halt({ halted: true, reason: HaltReason.IssuerPause }), true), NOW);
    expect(after.actions).toEqual([]);
    expect(after.skipped[0]).toMatchObject({ code: 'HALTED' });
  });
  it('marks the pause lifted once, so the authority knows a resume cross is due; only a resume cross lifts the halt', () => {
    const p = planHalt(f(halt({ halted: true, reason: HaltReason.IssuerPause }), false), NOW);
    expect(p.actions).toEqual([{ kind: 'sync-pause', halt: A(7), baseMint: A(5), because: 'unpaused' }]);
    const again = planHalt(f(halt({ halted: true, reason: HaltReason.IssuerPause, issuerUnpaused: true }), false), NOW);
    expect(again.actions).toEqual([]);
    expect(again.skipped[0]!.reason).toMatch(/lifted its pause/);
    expect(again.skipped[0]!.reason).toMatch(/resume cross/);
  });
  it('does nothing when the pause cannot be read, or for a halt of another cause', () => {
    expect(planHalt(f(halt(), null), NOW).actions).toEqual([]);
    expect(planHalt(f(halt({ halted: true, reason: HaltReason.VenueHalt }), false), NOW).actions).toEqual([]);
    expect(planHalt(f(halt({ halted: true, reason: HaltReason.IssuerPause }), true), NOW).actions).toEqual([]);
  });
  it('feeds the breaker an update that is new and young, and no other', () => {
    const upd = (age: bigint) => ({ account: A(8), publishTime: NOW - age });
    expect(planHalt(f(halt({ lastPublishTs: 0n }), false, upd(30n)), NOW).actions).toEqual([{ kind: 'observe-price', halt: A(7), baseMint: A(5), priceUpdate: A(8) }]);
    expect(planHalt(f(halt({ lastPublishTs: NOW - 30n }), false, upd(30n)), NOW).actions).toEqual([]); // already observed
    expect(planHalt(f(halt({ lastPublishTs: NOW - 40n }), false, upd(30n)), NOW).actions).toHaveLength(1); // newer than the last
    expect(planHalt(f(halt({ lastPublishTs: 0n }), false, upd(OBSERVE_MAX_AGE_SECS + 1n)), NOW).actions).toEqual([]); // too old for the program (120 s) once it lands
    expect(planHalt(f(halt({ lastPublishTs: 0n }), false, { account: A(8), publishTime: NOW + 60n }), NOW).actions).toEqual([]); // from the future
    expect(planHalt(f(halt({ lastPublishTs: 0n, halted: true, reason: HaltReason.CircuitBreaker }), false, upd(30n)), NOW).actions).toEqual([]); // already halted
    expect(planHalt(f(halt(), false, upd(30n)), NOW).actions).toEqual([]); // no breaker
  });
  it('reports a flagged corporate action', () => {
    const p = planHalt(f(halt({ halted: true, reason: HaltReason.CorporateAction, corporateAction: true }), false), NOW);
    expect(p.skipped.map((s) => s.code)).toEqual(['HALTED', 'CORPORATE_ACTION']);
  });
});
