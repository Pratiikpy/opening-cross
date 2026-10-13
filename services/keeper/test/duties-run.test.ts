// The keeper's duties run against an in-memory chain that applies what the keeper sends (test/helpers/world.ts): the pass does the work, a second pass finds nothing
// left to do (idempotence), a keeper started from nothing finds the same state and does not repeat the work (restart), and a dry run sends nothing.
import { describe, expect, it } from 'vitest';
import { type Instruction } from '@solana/kit';
import { CLEAR_DISCRIMINATOR, CrossState, HaltReason, PUSH_REFUNDS_DISCRIMINATOR, RELEASE_LOCKED_DISCRIMINATOR, SPAWN_NEXT_DISCRIMINATOR, SYNC_PAUSE_DISCRIMINATOR, getCrossDecoder, getHaltStateDecoder, getLockupDecoder, getSeriesDecoder, readCrossExt } from '@opening-cross/cross-core-client';
import { getCalendarEncoder } from '@opening-cross/cross-calendar-client';
import { none } from '@solana/kit';
import { type Deferred, runOnce } from '../src/index.js';
import { DAY, NOW, World, key } from './helpers/world.js';

const kinds = (r: Awaited<ReturnType<typeof runOnce>>) => r.done.map((d) => d.action.kind);
const startsWith = (ix: Instruction, d: ArrayLike<number>) => Array.from(d).every((b, i) => ix.data![i] === b);
const RULES = {}; // a cross with the rules tail and every rule off

describe('batched refunds', () => {
  it('refunds the orders that can only be refunded in one transaction, claims the rest, then finalizes; a second pass finds nothing', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Cleared, price: 100n, rules: RULES });
    const refunded = [await w.order(c, { side: 'buy', price: 50n }), await w.order(c, { side: 'sell', price: 150n }), await w.order(c, { side: 'buy', price: 10n, revealed: false })];
    const filled = [await w.order(c, { side: 'buy', price: 120n }), await w.order(c, { side: 'buy', price: 100n })];
    const r = await runOnce(w.deps({ duties: 'refunds' }));
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(kinds(r)).toEqual(['push-refunds', 'claim', 'claim', 'finalize']);
    const push = w.sent.find((ixs) => ixs.some((ix) => startsWith(ix, PUSH_REFUNDS_DISCRIMINATOR)))!;
    const touched = push.flatMap((ix) => ix.accounts!.map((a) => a.address));
    for (const o of refunded) expect(touched).toContain(o);
    for (const o of filled) expect(touched).not.toContain(o);
    expect(getCrossDecoder().decode(w.get(c)).state).toBe(CrossState.Finalized);
    // idempotence
    const sentBefore = w.sent.length;
    const again = await runOnce(w.deps({ duties: 'refunds' }));
    expect(again.done).toEqual([]);
    expect(again.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(w.sent.length).toBe(sentBefore);
  });

  it('a no-print cross is refunded in batches of at most twelve', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.NoPrint, rules: RULES });
    for (let i = 0; i < 30; i++) await w.order(c, { side: i % 2 ? 'buy' : 'sell', price: 100n });
    const r = await runOnce(w.deps({ duties: 'refunds' }));
    expect(kinds(r)).toEqual(['push-refunds', 'push-refunds', 'push-refunds', 'finalize']);
    expect(r.done.filter((d) => d.action.kind === 'push-refunds').map((d) => (d.action.kind === 'push-refunds' ? d.action.orders.length : 0))).toEqual([12, 12, 6]);
    expect(getCrossDecoder().decode(w.get(c)).ordersOpen).toBe(0);
  });

  it('without the duty, or on a cross of the earlier layout, each order is claimed as before', async () => {
    const w = await World.create();
    const withTail = await w.cross({ state: CrossState.NoPrint, rules: RULES });
    const old = await w.cross({ state: CrossState.NoPrint, rules: null });
    for (const c of [withTail, old]) for (let i = 0; i < 3; i++) await w.order(c, { side: 'buy', price: 100n });
    const off = await runOnce(w.deps({ duties: 'none' }));
    expect(off.done.filter((d) => d.action.kind === 'push-refunds')).toEqual([]);
    expect(off.done.filter((d) => d.action.kind === 'claim')).toHaveLength(6);

    const w2 = await World.create();
    const o2 = await w2.cross({ state: CrossState.NoPrint, rules: null });
    for (let i = 0; i < 3; i++) await w2.order(o2, { side: 'buy', price: 100n });
    const all = await runOnce(w2.deps({ duties: 'all' }));
    expect(all.done.map((d) => d.action.kind)).toEqual(['claim', 'claim', 'claim', 'finalize']);
    expect(w2.sent.flat().some((ix) => startsWith(ix, PUSH_REFUNDS_DISCRIMINATOR))).toBe(false);
  });

  it('a batch the program refuses is claimed order by order in the same pass, is not tried again for an hour by the same keeper, and is tried once by a restarted one', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.NoPrint, rules: RULES });
    for (let i = 0; i < 4; i++) await w.order(c, { side: 'buy', price: 100n });
    w.refuse.add('push_refunds');
    const attempts: string[] = [];
    const counted = (extra: Parameters<typeof w.deps>[0] = {}) => {
      const deps = w.deps({ duties: 'refunds', ...extra });
      return { ...deps, send: async (ixs: Instruction[]) => (ixs.some((ix) => startsWith(ix, PUSH_REFUNDS_DISCRIMINATOR)) && attempts.push('push'), deps.send(ixs)) };
    };
    const memory = new Map<string, Deferred>();
    const r = await runOnce(counted({ memory }));
    expect(attempts).toHaveLength(1);
    expect(r.failed.map((f) => f.action.kind)).toEqual(['push-refunds']);
    expect(r.done.filter((d) => d.action.kind === 'claim')).toHaveLength(4);
    expect(r.done.at(-1)!.action.kind).toBe('finalize');
    expect(getCrossDecoder().decode(w.get(c)).state).toBe(CrossState.Finalized);

    // three more refundable orders appear on the same cross: the keeper that learned the program refuses the batch claims them, without a second attempt
    const again = async () => {
      w.patchCross(c, (x) => ({ ...x, state: CrossState.NoPrint }));
      for (let i = 0; i < 3; i++) await w.order(c, { side: 'sell', price: 100n });
    };
    await again();
    const same = await runOnce(counted({ memory }));
    expect(attempts).toHaveLength(1);
    expect(same.failed).toEqual([]);
    expect(same.done.filter((d) => d.action.kind === 'claim')).toHaveLength(3);

    // a restarted keeper has no memory: it tries the batch once, is refused, and claims the same orders
    await again();
    const restarted = await runOnce(counted());
    expect(attempts).toHaveLength(2);
    expect(restarted.failed.map((f) => f.action.kind)).toEqual(['push-refunds']);
    expect(restarted.done.filter((d) => d.action.kind === 'claim')).toHaveLength(3);
  });
});

describe('insider challenges the arbiter left unanswered', () => {
  it('closes the ones past 14 days, waits for the others, and finalizes the moment the last one is gone', async () => {
    const w = await World.create();
    const insider = await key();
    const c = await w.cross({ state: CrossState.Cleared, price: 100n, rules: RULES, bond: 1_000_000n, insiders: [insider], clearedTs: NOW - 10_000n, filed: 2, open: 2 });
    await w.challenge(c, 0, NOW - 15n * DAY);
    await w.challenge(c, 1, NOW - 1n * DAY);
    const r = await runOnce(w.deps({ duties: 'challenges' }));
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(r.done.map((d) => (d.action.kind === 'expire-challenge' ? `expire:${d.action.id}` : d.action.kind))).toEqual(['expire:0']);
    expect(readCrossExt(w.get(c))!.neutralState.openChallenges).toBe(1);
    expect(r.skipped.map((s) => s.code).sort()).toEqual(['CHALLENGE_OPEN', 'CHALLENGE_WAITING']);

    // idempotence: nothing to do, nothing sent
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'challenges' }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);

    // thirteen days later the second one can be closed, and the cross finalizes in the same pass
    w.clock = NOW + 13n * DAY + 1n;
    const later = await runOnce(w.deps({ duties: 'challenges' }));
    expect(later.done.map((d) => (d.action.kind === 'expire-challenge' ? `expire:${d.action.id}` : d.action.kind))).toEqual(['expire:1', 'finalize']);
    expect(getCrossDecoder().decode(w.get(c)).state).toBe(CrossState.Finalized);
  });

  it('a keeper that restarts between the two steps does not repeat the first', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Cleared, rules: RULES, bond: 5n, insiders: [await key()], clearedTs: NOW - 10_000n, filed: 1, open: 1 });
    await w.challenge(c, 0, NOW - 20n * DAY);
    const memory = new Map<string, Deferred>();
    const first = await runOnce(w.deps({ duties: 'challenges', memory }));
    expect(first.done.map((d) => d.action.kind)).toEqual(['expire-challenge', 'finalize']);
    const sent = w.sent.length;
    const restarted = await runOnce(w.deps({ duties: 'challenges' })); // no memory: a new process
    expect(restarted.done).toEqual([]);
    expect(restarted.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(w.sent.length).toBe(sent);
  });

  it('a challenge another keeper closed first is not a failure', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Cleared, rules: RULES, bond: 5n, insiders: [await key()], clearedTs: NOW - 10_000n, filed: 1, open: 1 });
    const ch = await w.challenge(c, 0, NOW - 20n * DAY);
    const deps = w.deps({ duties: 'challenges' });
    const raced = { ...deps, send: async (ixs: Instruction[]) => (w.accounts.delete(ch), deps.send(ixs)) };
    const r = await runOnce(raced);
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(r.skipped.some((s) => /never created|cannot be settled/.test(s.reason))).toBe(true);
  });

  it('without the duty the challenges are left alone and the cross is held with the reason', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Cleared, rules: RULES, bond: 5n, insiders: [await key()], clearedTs: NOW - 10_000n, filed: 1, open: 1 });
    await w.challenge(c, 0, NOW - 20n * DAY);
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(r.done).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ code: 'CHALLENGE_OPEN' });
  });
});

describe('locked fills', () => {
  it('releases what has vested, again when more has, and the last remainder whatever the threshold', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Finalized, rules: RULES });
    const lock = await w.lockup({ cross: c, amount: 1_000n, startTs: NOW - 200n, cliffSecs: 50, vestSecs: 1_000 });
    const r = await runOnce(w.deps({ duties: 'locks', crosses: async () => [] }));
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(r.done.map((d) => (d.action.kind === 'release-locked' ? d.action.releasable : 0n))).toEqual([150n]);
    expect(getLockupDecoder().decode(w.get(lock)).released).toBe(150n);
    expect(w.sent.flat().some((ix) => startsWith(ix, RELEASE_LOCKED_DISCRIMINATOR))).toBe(true);

    // idempotence at the same moment
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'locks', crosses: async () => [] }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);

    // a threshold holds a small release back; far enough on, the rest is sent as the last release and the account closes
    w.clock = NOW + 100n;
    expect((await runOnce(w.deps({ duties: 'locks', crosses: async () => [], minRelease: 500n }))).done).toEqual([]);
    w.clock = NOW + 100_000n;
    const last = await runOnce(w.deps({ duties: 'locks', crosses: async () => [], minRelease: 10_000n }));
    expect(last.done.map((d) => (d.action.kind === 'release-locked' ? d.action.releasable : 0n))).toEqual([850n]);
    expect(w.accounts.has(lock)).toBe(false);
    // a lockup that is closed is not an error
    const closed = await runOnce(w.deps({ duties: 'locks', crosses: async () => [] }));
    expect(closed.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(closed.done).toEqual([]);
  });

  it('is not done unless asked for, and a scoped keeper leaves other issuers\' locks alone', async () => {
    const w = await World.create();
    const c = await w.cross({ state: CrossState.Finalized, rules: RULES });
    await w.lockup({ cross: c, amount: 1_000n, startTs: NOW - 5_000n, cliffSecs: 0, vestSecs: 1_000 });
    expect((await runOnce(w.deps({ duties: 'refunds,challenges,halts,series', crosses: async () => [] }))).done).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'locks', crosses: async () => [], accept: () => false }))).done).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'locks', crosses: async () => [] }))).done).toHaveLength(1);
  });
});

describe('recurring series', () => {
  it('spawns the next cross when the program would accept it, creates its shards, and waits while it is live', async () => {
    const w = await World.create();
    const s = await w.series({ startTs: NOW + 1_000n });
    const r = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(kinds(r)).toEqual(['spawn-next']);
    const series = getSeriesDecoder().decode(w.get(s));
    expect(series.nextIndex).toBe(1n);
    expect(series.lastCloseTs).toBe(NOW + 1_000n);
    expect(w.sent.flat().some((ix) => startsWith(ix, SPAWN_NEXT_DISCRIMINATOR))).toBe(true);
    expect(w.shards.size).toBe(2); // the two main shards of the spawned cross

    // idempotence: the spawned cross is live, so the series waits
    const sent = w.sent.length;
    const again = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(again.done).toEqual([]);
    expect(again.skipped[0]).toMatchObject({ code: 'SERIES_WAITING' });
    expect(again.skipped[0]!.reason).toMatch(/still live/);
    expect(w.sent.length).toBe(sent);

    // the first cross clears; its close has passed; the next slot is within the day: the second is spawned
    const first = series.lastCross.__option === 'Some' ? series.lastCross.value : null;
    w.patchCross(first!, (c) => ({ ...c, state: CrossState.Cleared }));
    w.clock = NOW + 1_100n;
    const second = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(kinds(second)).toEqual(['spawn-next']);
    expect(getSeriesDecoder().decode(w.get(s)).nextIndex).toBe(2n);
  });

  it('waits for the day before the call, a paused series, and a series that has run its last cross', async () => {
    const w = await World.create();
    await w.series({ startTs: NOW + 3n * DAY });
    await w.series({ startTs: NOW + 1_000n, active: false });
    const r = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(r.done).toEqual([]);
    expect(r.skipped.map((s) => s.code).sort()).toEqual(['SERIES_PAUSED', 'SERIES_WAITING']);
    expect(w.sent).toEqual([]);
  });

  it('follows a calendar: the next cross closes at the earliest session start ahead', async () => {
    const w = await World.create();
    const calendar = await key();
    w.accounts.set(calendar, new Uint8Array(getCalendarEncoder().encode({ admin: w.payer.address, id: 1n, timelockSecs: 604_800n, sessions: [{ startTs: NOW + 500n, endTs: NOW + 5_000n }, { startTs: NOW + 30n * DAY, endTs: NOW + 31n * DAY }], feeds: [], pending: none(), pendingAdmin: none(), bump: 255 } as never)));
    const s = await w.series({ startTs: 0n, intervalSecs: 0n, calendar });
    const r = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(kinds(r)).toEqual(['spawn-next']);
    expect(getSeriesDecoder().decode(w.get(s)).lastCloseTs).toBe(NOW + 500n);
  });

  it('a spawn the program refuses is reported, and a failure creating the shards after a spawn is reported with the cross', async () => {
    const w = await World.create();
    await w.series({ startTs: NOW + 1_000n });
    w.refuse.add('spawn_next');
    const refused = await runOnce(w.deps({ duties: 'series', crosses: async () => [] }));
    expect(refused.done).toEqual([]);
    expect(refused.failed).toHaveLength(1);
    w.refuse.clear();
    const deps = w.deps({ duties: 'series', crosses: async () => [] });
    let sends = 0;
    const flaky = { ...deps, send: async (ixs: Instruction[]) => { if (++sends === 2) throw new Error('shard transaction dropped'); return deps.send(ixs); } };
    const r = await runOnce(flaky);
    expect(r.done.map((d) => d.action.kind)).toEqual(['spawn-next']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toMatch(/created its shards failed|shards failed/);
  });

  it('a dry run plans the spawn and sends nothing', async () => {
    const w = await World.create();
    const s = await w.series({ startTs: NOW + 1_000n });
    const r = await runOnce(w.deps({ duties: 'series', crosses: async () => [], dryRun: true }));
    expect(r.done).toEqual([]);
    expect(r.planned.map((a) => a.kind)).toEqual(['spawn-next']);
    expect(w.sent).toEqual([]);
    expect(getSeriesDecoder().decode(w.get(s)).nextIndex).toBe(0n);
  });
});

describe('halt states', () => {
  it('copies the issuer\'s pause, then the lifting of it, each once, and never lifts the halt itself', async () => {
    const w = await World.create();
    const h = await w.halt({});
    w.paused.add(w.base);
    const r = await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }));
    expect(r.done.map((d) => d.action.kind === 'sync-pause' && d.action.because)).toEqual(['paused']);
    expect(getHaltStateDecoder().decode(w.get(h))).toMatchObject({ halted: true, reason: HaltReason.IssuerPause });
    const sent = w.sent.length;
    const again = await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }));
    expect(again.done).toEqual([]);
    expect(again.skipped[0]).toMatchObject({ code: 'HALTED' });
    expect(w.sent.length).toBe(sent);

    w.paused.delete(w.base);
    const lifted = await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }));
    expect(lifted.done.map((d) => d.action.kind === 'sync-pause' && d.action.because)).toEqual(['unpaused']);
    expect(getHaltStateDecoder().decode(w.get(h))).toMatchObject({ halted: true, issuerUnpaused: true });
    expect((await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }))).done).toEqual([]);
    expect(getHaltStateDecoder().decode(w.get(h)).halted).toBe(true); // only a printing resume cross lifts it
  });

  it('feeds the circuit breaker one new, young update at a time', async () => {
    const w = await World.create();
    const feed = new Uint8Array(32).fill(7);
    const hex = Buffer.from(feed).toString('hex');
    const h = await w.halt({ breaker: { feedId: feed } });
    const account = await key();
    w.updates.set(hex, { account, publishTime: NOW - 20n });
    const r = await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }));
    expect(r.done.map((d) => d.action.kind)).toEqual(['observe-price']);
    const breaker = getHaltStateDecoder().decode(w.get(h)).breaker;
    expect(breaker.__option === 'Some' && breaker.value.lastPublishTs).toBe(NOW - 20n);
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);
    // a newer one is observed; one older than the program accepts never is
    w.clock = NOW + 60n;
    w.updates.set(hex, { account, publishTime: NOW + 50n });
    expect((await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }))).done).toHaveLength(1);
    w.clock = NOW + 400n;
    w.updates.set(hex, { account, publishTime: NOW + 100n });
    expect((await runOnce(w.deps({ duties: 'halts', crosses: async () => [] }))).done).toEqual([]);
  });

  it('does nothing when the mint\'s pause or the oracle cannot be read, and reports a flagged corporate action', async () => {
    const w = await World.create();
    await w.halt({ breaker: { feedId: new Uint8Array(32) } });
    const r = await runOnce(w.deps({ duties: 'halts', crosses: async () => [], mintPaused: async () => { throw new Error('rpc down'); }, priceUpdate: async () => { throw new Error('rpc down'); } }));
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    const w2 = await World.create();
    await w2.halt({ halted: true, reason: HaltReason.CorporateAction, corporateAction: true });
    const ca = await runOnce(w2.deps({ duties: 'halts', crosses: async () => [] }));
    expect(ca.skipped.map((s) => s.code)).toEqual(['HALTED', 'CORPORATE_ACTION']);
  });

  it('runs before the crosses, so a cross naming the halt state is cleared against the pause: the clear is given the halt state and prints no price', async () => {
    const w = await World.create();
    const h = await w.halt({});
    w.paused.add(w.base);
    const c = await w.cross({ state: CrossState.Live, rules: RULES, haltSource: h });
    const r = await runOnce(w.deps({ duties: 'halts' }));
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(kinds(r)).toEqual(['sync-pause', 'settle', 'finalize']); // no orders: the cross that printed no price is finalized at once
    const order = w.sent.map((ixs) => (ixs.some((ix) => startsWith(ix, SYNC_PAUSE_DISCRIMINATOR)) ? 'sync' : ixs.some((ix) => startsWith(ix, CLEAR_DISCRIMINATOR)) ? 'clear' : 'merge'));
    expect(order.indexOf('sync')).toBeLessThan(order.indexOf('clear'));
    const clear = w.sent.flat().find((ix) => startsWith(ix, CLEAR_DISCRIMINATOR))!;
    expect(clear.accounts!.map((a) => a.address)).toContain(h);
    expect(getCrossDecoder().decode(w.get(c)).clearing.__option).toBe('None'); // no price was printed
  });

  it('a corporate action flagged on the halt state reaches the clear and the cross prints no price', async () => {
    const w = await World.create();
    const h = await w.halt({ halted: true, reason: HaltReason.CorporateAction, corporateAction: true });
    const c = await w.cross({ state: CrossState.Live, rules: RULES, haltSource: h });
    await runOnce(w.deps({ duties: 'halts' }));
    expect(getCrossDecoder().decode(w.get(c)).state).not.toBe(CrossState.Cleared);
    const clear = w.sent.flat().find((ix) => startsWith(ix, CLEAR_DISCRIMINATOR))!;
    expect(clear.accounts!.map((a) => a.address)).toContain(h);
  });
});

describe('dry run, and a keeper built before the duties existed', () => {
  it('plans the lifecycle and sends nothing', async () => {
    const w = await World.create();
    await w.cross({ state: CrossState.Live, rules: null });
    const r = await runOnce(w.deps({ duties: 'all', dryRun: true }));
    expect(r.done).toEqual([]);
    expect(r.planned.map((a) => a.kind)).toEqual(['settle']);
    expect(w.sent).toEqual([]);
  });

  it('deps without the duty inputs do the lifecycle only, and a cross of the earlier layout settles as it always did', async () => {
    const w = await World.create();
    const old = await w.cross({ state: CrossState.Live, rules: null });
    const { duties, lockups, series, halts, mintPaused, priceUpdate, ...legacy } = w.deps();
    void duties; void lockups; void series; void halts; void mintPaused; void priceUpdate;
    const r = await runOnce(legacy);
    expect(kinds(r)).toContain('settle');
    expect(r.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
    expect(getCrossDecoder().decode(w.get(old)).state).toBe(CrossState.Finalized); // settled, then finalized (it has no orders)
    // every duty named but none of their discovery wired: nothing happens, and nothing throws
    const named = await runOnce({ ...legacy, duties: new Set(['refunds', 'challenges', 'locks', 'series', 'halts'] as const) });
    expect(named.failed.map((f) => `${f.action.kind}: ${f.error}`)).toEqual([]);
  });
});
