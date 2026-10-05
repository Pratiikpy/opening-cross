// Indexer (ROADMAP D1): events captured from real cross_core transactions are ingested into
// Postgres; the projection must equal chain state, re-ingestion must be a no-op, and the
// reconciler must catch what the event stream missed. Log attribution is tested against spoofed
// and truncated streams. The Postgres part needs DATABASE_URL (CI starts a postgres service).
import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, Disclosure, getOrderClaimedEventEncoder } from '@opening-cross/cross-core-client';
import { OrderSide } from '@opening-cross/sdk';
import { UnattributableLogs, decodeLogs, ingestTransaction, reconcile } from '@opening-cross/indexer';
import { freshDb } from '../src/db.js';
import { World } from '../src/world.js';

const OTHER = '7Kb2feBGE34ck7F7dovaEgKVJRLJ2JeUFxCyo4bamZJD';

describe('log attribution', () => {
  const claimed = Buffer.from(
    getOrderClaimedEventEncoder().encode({ cross: OTHER as Address, order: OTHER as Address, owner: OTHER as Address, side: 0, fill: 1n, quoteOut: 2n, baseOut: 3n, fee: 4n }),
  ).toString('base64');

  it('accepts events written by cross_core, directly or under CPI', () => {
    const logs = [
      `Program ${OTHER} invoke [1]`,
      `Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [2]`,
      `Program data: ${claimed}`,
      `Program ${CROSS_CORE_PROGRAM_ADDRESS} success`,
      `Program ${OTHER} success`,
    ];
    const ev = decodeLogs(logs);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.name).toBe('OrderClaimed');
  });

  it('ignores an identical payload written by another program', () => {
    const logs = [`Program ${OTHER} invoke [1]`, `Program data: ${claimed}`, `Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [2]`, `Program ${CROSS_CORE_PROGRAM_ADDRESS} success`, `Program data: ${claimed}`, `Program ${OTHER} success`];
    expect(decodeLogs(logs)).toHaveLength(0);
  });

  it('refuses truncated or unbalanced logs instead of guessing', () => {
    expect(() => decodeLogs([`Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [1]`, 'Log truncated'])).toThrow(UnattributableLogs);
    expect(() => decodeLogs([`Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [1]`, `Program ${OTHER} success`])).toThrow(UnattributableLogs);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('indexer against Postgres', () => {
  it('projects a full sealed cross lifecycle exactly, idempotently, and reconciles to zero drift', async () => {
    const { db } = await freshDb();

    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Sealed });
    const s1 = await w.trader(0n, 3_000_000_000n);
    const s2 = await w.trader(0n, 3_000_000_000n);
    const b1 = await w.trader(10_000_000_000n);
    const b2 = await w.trader(10_000_000_000n);
    const b3 = await w.trader(10_000_000_000n);
    const orders = [
      await w.place(cross, s1, OrderSide.Sell, 1_100_000n, 1_500_000_000n),
      await w.place(cross, s2, OrderSide.Sell, 1_400_000n, 1_000_000_000n),
      await w.place(cross, b1, OrderSide.Buy, 1_500_000n, 1_000_000_000n),
      await w.place(cross, b2, OrderSide.Buy, 1_300_000n, 1_000_000_000n),
      await w.place(cross, b3, OrderSide.Buy, 1_900_000n, 400_000_000n, { reveal: false }),
    ];
    const cancelled = await w.place(cross, b2, OrderSide.Buy, 1_200_000n, 100_000_000n);
    await w.cancel(cross, cancelled);
    await w.revealAll(cross, orders);
    const settled = await w.settle(cross);
    await w.claimAll(cross, orders);
    const done = await w.finalize(cross);

    const fetch = async (a: Address) => { const x = w.h.svm.getAccount(a); return x.exists ? x.data : null; };
    let applied = 0;
    for (const tx of w.h.landed) applied += await ingestTransaction(db, tx);
    expect(applied).toBeGreaterThan(10);
    // Replaying the whole stream changes nothing.
    let replay = 0;
    for (const tx of w.h.landed) replay += await ingestTransaction(db, tx);
    expect(replay).toBe(0);

    const { rows: [c] } = await db.query('SELECT * FROM crosses WHERE address = $1', [cross.address]);
    const clr = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
    expect(clr).not.toBeNull();
    expect(c.state).toBe('Finalized');
    expect(c.clearing_price).toBe(clr!.price.toString());
    expect(c.matched).toBe(clr!.matched.toString());
    expect(c.orders_committed).toBe(done.data.ordersTotal);

    const { rows: os } = await db.query('SELECT * FROM orders WHERE cross_address = $1 ORDER BY idx', [cross.address]);
    expect(os.map((o) => o.status)).toEqual(['claimed', 'claimed', 'claimed', 'claimed', 'claimed', 'cancelled']);
    expect(os[4].price).toBeNull(); // never revealed: refunded, no price ever published
    expect(os[4].fill).toBe('0');
    // Indexed fills balance: base bought equals base sold equals matched.
    const sum = (side: number, col: string) => os.filter((o) => o.side === side && o.status === 'claimed').reduce((a, o) => a + BigInt(o[col]), 0n);
    expect(sum(0, 'fill')).toBe(clr!.matched);
    expect(sum(1, 'fill')).toBe(clr!.matched);

    expect(await reconcile(db, fetch)).toEqual([]);

    // A lost event (e.g. truncated logs) shows up as drift against the chain.
    await db.query(`UPDATE orders SET status = 'revealed' WHERE cross_address = $1 AND idx = 0`, [cross.address]);
    await db.query(`UPDATE crosses SET state = 'Cleared' WHERE address = $1`, [cross.address]);
    const drift = await reconcile(db, fetch, { record: true });
    expect(drift.map((d) => d.field).sort()).toEqual(['order[0].exists', 'orders_open', 'state']);
    const { rows: alerts } = await db.query('SELECT count(*)::int AS n FROM reconciliation_alerts');
    expect(alerts[0].n).toBe(3);
    await db.end();
  });

  it('ignores failed transactions', async () => {
    const { db } = await freshDb();
    const w = await World.create();
    await w.newCross();
    const tx = w.h.landed.at(-2)!;
    expect(await ingestTransaction(db, { ...tx, signature: `${tx.signature}x`, err: { InstructionError: [0, 'Custom'] } })).toBe(0);
    await db.end();
  });
});
