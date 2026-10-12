// Keepers (ROADMAP D2): permissionless, idempotent cranking of every cross to Finalized. Two
// keepers with different fee payers race over the same crosses — a printed sealed cross with an
// unrevealed bid, a no-print, and a deferred-mint launch whose settler never binds a mint — and
// the end state must be exactly what one careful operator would produce: every order settled to
// its owner, every vault drained, nothing paid twice. Discovery comes from the indexer's decoder
// over the transactions that actually landed.
import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { CrossState, Disclosure, OrderSide, SupplyMode } from '@opening-cross/sdk';
import { decodeLogs } from '@opening-cross/indexer';
import { type KeeperDeps, plan, pollingSender, runOnce } from '@opening-cross/keeper';
import type { IndexerRpc } from '@opening-cross/indexer';
import { NoPrintReason } from '@opening-cross/cross-core-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

function keeper(w: World, payer: KeeperDeps['payer']): KeeperDeps {
  const events = () => w.h.landed.flatMap((t) => decodeLogs(t.logs));
  return {
    payer,
    now: async () => w.h.svm.getClock().unixTimestamp,
    fetch: async (a: Address) => { const x = w.h.svm.getAccount(a); return x.exists ? x.data : null; },
    crosses: async () => [...new Set(events().filter((e) => e.name === 'CrossCreated').map((e) => e.data.cross))],
    orders: async (cross) => events().flatMap((e) => (e.name === 'OrderCommitted' && e.data.cross === cross ? [e.data.order] : [])),
    send: async (ixs) => { await w.h.send(ixs, payer); return w.h.landed.at(-1)!.signature; },
  };
}

/** A minimal RPC double for the HTTP-only sender: every method returns `{ send }` like the real client. */
function fakeRpc(o: { sendFails?: unknown[]; confirmAfter?: number[]; heightAfter?: number[]; sendError?: unknown }) {
  const calls = { blockhash: 0, send: 0, status: 0 };
  const sendFails = [...(o.sendFails ?? [])];
  let blockhashes = 0;
  let polls = 0;
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => { calls.blockhash++; blockhashes++; polls = 0; return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n } }; } }),
    sendTransaction: () => ({ send: async () => { calls.send++; if (o.sendError) throw o.sendError; const f = sendFails.shift(); if (f) throw f; return 'sig'; } }),
    getSignatureStatuses: () => ({ send: async () => { calls.status++; polls++; const after = o.confirmAfter?.[blockhashes - 1]; return { value: [after !== undefined && polls >= after ? { err: null, confirmationStatus: 'confirmed' } : null] }; } }),
    getBlockHeight: () => ({ send: async () => (o.heightAfter?.[blockhashes - 1] !== undefined && polls >= o.heightAfter[blockhashes - 1]! ? 101n : 50n) }),
  };
  return { rpc: rpc as unknown as IndexerRpc, calls };
}

describe('http-only sender', () => {
  const opts = { resendMs: 0, pollMs: 0, sleep: async () => {} };
  it('rides out a node that has not seen the blockhash yet, then confirms by polling', async () => {
    const w = await World.create();
    const { rpc, calls } = fakeRpc({ sendFails: [new Error('Transaction simulation failed: Blockhash not found')], confirmAfter: [3] });
    const sig = await pollingSender(rpc, await w.h.wallet(), opts)([]);
    expect(typeof sig).toBe('string');
    expect(calls.blockhash).toBe(1);
    expect(calls.send).toBeGreaterThanOrEqual(2); // the refused attempt, then the broadcast (re-sent while unconfirmed)
  });

  it('rebuilds on a fresh blockhash when the first one expires unconfirmed', async () => {
    const w = await World.create();
    const { rpc, calls } = fakeRpc({ confirmAfter: [undefined as unknown as number, 2], heightAfter: [2] });
    await pollingSender(rpc, await w.h.wallet(), opts)([]);
    expect(calls.blockhash).toBe(2);
  });

  it('reports a transaction that landed with an error, and rethrows a refusal from the preflight', async () => {
    const w = await World.create();
    const failing = { ...fakeRpc({}).rpc, getSignatureStatuses: () => ({ send: async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] }) }) } as unknown as IndexerRpc;
    await expect(pollingSender(failing, await w.h.wallet(), opts)([])).rejects.toThrow(/failed/);
    const refused = new Error('AnchorError: WrongState');
    const { rpc } = fakeRpc({ sendError: refused });
    await expect(pollingSender(rpc, await w.h.wallet(), opts)([])).rejects.toBe(refused);
  });
});

describe('keeper', () => {
  it('two racing keepers take every kind of cross to Finalized, paying each owner exactly once', async () => {
    const w = await World.create();
    // 1. Sealed, prints, one bid never revealed.
    const sealed = await w.newCross({ disclosure: Disclosure.Sealed });
    const s1 = await w.trader(0n, 2_000_000_000n);
    const b1 = await w.trader(10_000_000_000n);
    const b2 = await w.trader(10_000_000_000n);
    const so = [
      await w.place(sealed, s1, OrderSide.Sell, 1_100_000n, 2_000_000_000n),
      await w.place(sealed, b1, OrderSide.Buy, 1_300_000n, 1_000_000_000n),
      await w.place(sealed, b2, OrderSide.Buy, 1_900_000n, 500_000_000n, { reveal: false }),
    ];
    await w.revealAll(sealed, so);
    w.h.setTime(T0);
    // 2. No print: volume below the minimum.
    const noprint = await w.newCross({ minMatched: 10_000_000_000n });
    const b3 = await w.trader(10_000_000_000n);
    const s2 = await w.trader(0n, 1_000_000_000n);
    await w.place(noprint, b3, OrderSide.Buy, 1_500_000n, 100_000_000n);
    await w.place(noprint, s2, OrderSide.Sell, 1_000_000n, 100_000_000n);
    // 3. Deferred mint whose settler never binds.
    const settler = await w.h.wallet();
    const deferred = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: [{ price: 1_000_000n, quantity: 2_000_000_000n }], settler: settler.address, settleDeadlineTs: T0 + 1_000n });
    const b4 = await w.trader(10_000_000_000n);
    await w.place(deferred, b4, OrderSide.Buy, 1_200_000n, 1_000_000_000n);

    const k1 = keeper(w, await w.h.wallet());
    const k2 = keeper(w, await w.h.wallet());
    const quote = (who: Address) => w.h.balanceOf(who, w.quoteMint);
    const before = { b2: await quote(b2.address), b3: await quote(b3.address), b4: await quote(b4.address) };

    // Before any reveal window ends there is nothing to do.
    expect((await runOnce(k1)).done).toEqual([]);

    // Past every reveal window but before the deferred deadline.
    w.h.setTime(T0 + 300n);
    const races = [await runOnce(k1), await runOnce(k2), await runOnce(k1)];
    expect(races.flatMap((r) => r.skipped).some((s) => s.cross === deferred.address && /binding|bind/.test(s.reason))).toBe(true);
    expect(w.view(sealed.address).data.state).toBe(CrossState.Finalized);
    expect(w.view(noprint.address).data.state).toBe(CrossState.Finalized);
    expect(w.view(deferred.address).data.state).toBe(CrossState.Cleared);

    // Past the deadline: abandoned, refunded, finalized.
    w.h.setTime(T0 + 1_000n);
    await runOnce(k2);
    await runOnce(k1);
    await runOnce(k2);
    const end = w.view(deferred.address).data;
    expect(end.state).toBe(CrossState.Finalized);
    expect(end.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.SettlementExpired });

    // Everything is settled and nothing is left for any keeper to do.
    const idle = [await runOnce(k1), await runOnce(k2)];
    expect(idle.flatMap((r) => [...r.done, ...r.failed])).toEqual([]);
    for (const c of [sealed, noprint, deferred]) expect(w.view(c.address).data.ordersOpen).toBe(0);

    // Owners got their money: refunds in full for the unrevealed bid, the no-print and the abandoned launch.
    expect(await quote(b2.address)).toBe(before.b2 + so[2]!.escrow);
    expect(await quote(b3.address)).toBeGreaterThan(before.b3);
    expect(await quote(b4.address)).toBe(10_000_000_000n);
    expect(await quote(b3.address)).toBe(10_000_000_000n);
    // The sealed cross printed and the revealed buyer received base.
    expect(await w.h.balanceOf(b1.address, w.baseMint)).toBeGreaterThan(0n);
  });

  it('plans nothing for a live cross before its reveal window ends, and settles it after', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const c = cross.data;
    expect(plan(cross.address, c, [], c.revealEndTs - 1n).actions).toEqual([]);
    expect(plan(cross.address, c, [], c.revealEndTs).actions).toEqual([{ kind: 'settle', cross: cross.address }]);
  });

  it('reports a failure without stopping the pass when a step is refused', async () => {
    const w = await World.create();
    const guarded = await w.newCross({ oracle: { feedId: new Uint8Array(32).fill(7), maxDivergenceBps: 300, maxStalenessSecs: 600 } });
    const plain = await w.newCross();
    w.h.setTime(T0 + 300n);
    const k = keeper(w, await w.h.wallet());
    const r = await runOnce(k);
    expect(r.failed.map((f) => [f.action.cross, f.error])).toEqual([[guarded.address, 'oracle-guarded cross: no Pyth price update available']]);
    expect(w.view(plain.address).data.state).toBe(CrossState.Finalized);
  });

  it('a keeper scoped to other creators leaves a cross alone; one scoped to its creator finishes it', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const trader = await w.trader(5_000_000_000n);
    await w.place(cross, trader, OrderSide.Buy, 1_100_000n, 1_000_000_000n);
    w.h.setTime(T0 + 300n);
    const other = await runOnce({ ...keeper(w, await w.h.wallet()), accept: (c) => c.creator !== cross.data.creator });
    expect([other.done, other.failed, other.skipped]).toEqual([[], [], []]);
    expect(w.view(cross.address).data.state).toBe(CrossState.Live);
    await runOnce({ ...keeper(w, await w.h.wallet()), accept: (c) => c.creator === cross.data.creator });
    expect(w.view(cross.address).data.state).toBe(CrossState.Finalized);
  });
});
