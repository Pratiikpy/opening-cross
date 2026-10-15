// Row V-E (keeper side): `push_refunds`, `release_locked` and `expire_challenge` are not only planned, they are sent. This reads the transactions the keeper hands to the
// chain on an in-memory chain that applies each of them (test/helpers/world.ts), and checks by instruction discriminator, the way the program tells them apart, what
// went out and what it changed. The tests that exercise each duty's edge cases are in duties-run.test.ts; this one is the cross-cutting statement that all three exist
// in the keeper's output, under the keeper's own default duty list and the one the operator adds `locks` to.
import { describe, expect, it } from 'vitest';
import type { Instruction } from '@solana/kit';
import {
  CrossState,
  EXPIRE_CHALLENGE_DISCRIMINATOR,
  FINALIZE_DISCRIMINATOR,
  PUSH_REFUNDS_DISCRIMINATOR,
  RELEASE_LOCKED_DISCRIMINATOR,
  getCrossDecoder,
  getLockupDecoder,
  readCrossExt,
} from '@opening-cross/cross-core-client';
import { DEFAULT_DUTIES, runOnce } from '../src/index.js';
import { DAY, NOW, World } from './helpers/world.js';

const is = (ix: Instruction, d: ArrayLike<number>) => Array.from(d).every((b, i) => ix.data?.[i] === b);
const count = (w: World, d: ArrayLike<number>) => w.sent.flat().filter((ix) => is(ix, d)).length;

/** One world holding all three situations: refund-only orders on a no-print cross, an insider challenge the arbiter let lapse, and a locked fill that has vested. */
async function world() {
  const w = await World.create();
  const refunds = await w.cross({ state: CrossState.NoPrint, rules: {} });
  for (let i = 0; i < 5; i++) await w.order(refunds, { side: i % 2 ? 'buy' : 'sell', price: 100n });
  const insider = await w.cross({ state: CrossState.Cleared, price: 100n, rules: {}, bond: 1_000_000n, challengeSecs: 3_600, clearedTs: NOW - 20n * DAY, filed: 1, open: 1 });
  const challenge = await w.challenge(insider, 0, NOW - 15n * DAY);
  const locked = await w.cross({ state: CrossState.Finalized });
  const lockup = await w.lockup({ cross: locked, amount: 1_000n, startTs: NOW - 10n * DAY, cliffSecs: 0, vestSecs: 20 * 86_400 });
  return { w, refunds, insider, challenge, locked, lockup };
}

describe('what the keeper sends', () => {
  it('push_refunds: the refund-only orders of a cross that did not print leave in batches, and the cross is finalized behind them', async () => {
    const { w, refunds } = await world();
    const r = await runOnce(w.deps({ duties: 'refunds' }));
    expect(r.failed).toEqual([]);
    expect(count(w, PUSH_REFUNDS_DISCRIMINATOR)).toBe(1); // five orders, one batch of up to twelve
    const push = w.sent.flat().find((ix) => is(ix, PUSH_REFUNDS_DISCRIMINATOR))!;
    expect(push.accounts!.map((a) => a.address)).toContain(refunds);
    expect(getCrossDecoder().decode(w.get(refunds))).toMatchObject({ ordersOpen: 0, state: CrossState.Finalized });
  });

  it('expire_challenge: a challenge the arbiter left for 14 days is closed by the keeper, which then finalizes the cross', async () => {
    const { w, insider, challenge } = await world();
    const r = await runOnce(w.deps({ duties: 'challenges' }));
    expect(r.failed).toEqual([]);
    expect(count(w, EXPIRE_CHALLENGE_DISCRIMINATOR)).toBe(1);
    const sent = w.sent.flat().find((ix) => is(ix, EXPIRE_CHALLENGE_DISCRIMINATOR))!;
    expect(sent.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([insider, challenge]));
    expect(w.accounts.has(challenge)).toBe(false);
    expect(readCrossExt(w.get(insider))!.neutralState.openChallenges).toBe(0);
    expect(getCrossDecoder().decode(w.get(insider)).state).toBe(CrossState.Finalized);
  });

  it('release_locked: the vested part of a locked fill is paid out by the keeper when the operator names the duty', async () => {
    const { w, lockup } = await world();
    const r = await runOnce(w.deps({ duties: 'locks' }));
    expect(r.failed).toEqual([]);
    expect(count(w, RELEASE_LOCKED_DISCRIMINATOR)).toBe(1);
    // 10 of 20 vesting days have passed: half of 1,000.
    expect(getLockupDecoder().decode(w.get(lockup)).released).toBe(500n);
  });

  it('the three together, in one pass, under the duties an operator would run; none of them fails and a second pass sends nothing', async () => {
    const { w } = await world();
    const duties = [...DEFAULT_DUTIES, 'locks'].join(',');
    const r = await runOnce(w.deps({ duties }));
    expect(r.failed).toEqual([]);
    expect([PUSH_REFUNDS_DISCRIMINATOR, EXPIRE_CHALLENGE_DISCRIMINATOR, RELEASE_LOCKED_DISCRIMINATOR, FINALIZE_DISCRIMINATOR].map((d) => count(w, d))).toEqual([1, 1, 1, 2]);
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);
  });

  it('under the keeper\'s default duties the first two are sent and the third is not: lock releases open the owner\'s token account at the keeper\'s cost, so they are asked for by name', async () => {
    const { w } = await world();
    const r = await runOnce(w.deps({ duties: 'default' }));
    expect(r.failed).toEqual([]);
    expect(count(w, PUSH_REFUNDS_DISCRIMINATOR)).toBe(1);
    expect(count(w, EXPIRE_CHALLENGE_DISCRIMINATOR)).toBe(1);
    expect(count(w, RELEASE_LOCKED_DISCRIMINATOR)).toBe(0);
  });

  it('with no duties named the keeper claims every order one by one and sends none of the three', async () => {
    const { w } = await world();
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(count(w, PUSH_REFUNDS_DISCRIMINATOR) + count(w, EXPIRE_CHALLENGE_DISCRIMINATOR) + count(w, RELEASE_LOCKED_DISCRIMINATOR)).toBe(0);
    expect(r.done.filter((d) => d.action.kind === 'claim')).toHaveLength(5);
  });
});
