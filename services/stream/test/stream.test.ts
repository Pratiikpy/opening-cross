// The gRPC stream over a real local socket: replay, resume, filter, follow, heartbeat, cancel, a stalled client, an event this
// build does not know, and the bearer token. The source is in memory here; the Postgres source has its own tests below.
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { type WireMessage, createClient, createStreamServer, listen, toWire } from '../src/index.js';
import type { EventFilter, EventRow, EventSource } from '../src/index.js';

const CROSS_A = 'CrossAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CROSS_B = 'CrossBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

class MemorySource implements EventSource {
  rows: EventRow[] = [];
  reads = 0;
  failNext = false;
  push(name: string, cross: string | null, payload: Record<string, unknown>): EventRow {
    const position = BigInt(this.rows.length + 1);
    const r: EventRow = { position, signature: `sig${position}`, seq: 0, slot: 100n + position, blockTime: 1_800_000_000n + position, name, cross, payload };
    this.rows.push(r);
    return r;
  }
  async next(after: bigint, limit: number, filter: EventFilter): Promise<EventRow[]> {
    this.reads++;
    if (this.failNext) throw new Error('connection refused');
    return this.rows
      .filter((r) => r.position > after && (!filter.crosses?.size || (r.cross !== null && filter.crosses.has(r.cross))) && (!filter.events?.size || filter.events.has(r.name)))
      .slice(0, limit);
  }
  async head() {
    return { position: BigInt(this.rows.length), events: BigInt(this.rows.length) };
  }
}

const created = (cross: string) => ({ cross, creator: 'Creator', kind: 1, supplyMode: 0, disclosure: 1, baseMint: 'B', quoteMint: 'Q', openTs: '100', closeTs: '200', revealEndTs: '200', protocolFeeBps: 5, integratorFeeBps: 0 });
const committed = (cross: string, order: string) => ({ cross, order, owner: 'Owner', side: 1, escrow: '200000000', index: 0, sealed: false });

const open: { stop: () => void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) o.stop();
});

async function start(source: EventSource, o: Partial<Parameters<typeof createStreamServer>[0]> = {}) {
  const server = createStreamServer({ source, pollMs: 10, heartbeatMs: 40, ...o });
  const port = await listen(server, '127.0.0.1:0');
  const client = createClient(`127.0.0.1:${port}`);
  open.push({ stop: () => (client.close(), server.forceShutdown()) });
  return { client, server, port };
}

async function take(it: AsyncIterable<WireMessage> & { cancel: () => void }, n: number, only: 'event' | 'any' = 'event'): Promise<WireMessage[]> {
  const out: WireMessage[] = [];
  for await (const m of it) {
    if (only === 'event' && m.body !== 'event') continue;
    out.push(m);
    if (out.length >= n) break;
  }
  it.cancel();
  return out;
}

describe('typed conversion', () => {
  it('turns each event into its message with names, not numbers', () => {
    const row = (name: string, payload: Record<string, unknown>): EventRow => ({ position: 7n, signature: 's', seq: 2, slot: 9n, blockTime: null, name, cross: 'C', payload });
    expect(toWire(row('CrossCreated', created('C')))).toMatchObject({ cursor: { position: '7' }, slot: '9', block_time: '0', cross_created: { kind: 'reopen', supply_mode: 'escrow', disclosure: 'open', open_ts: '100', protocol_fee_bps: 5 } });
    expect(toWire(row('OrderCommitted', committed('C', 'O')))).toMatchObject({ order_committed: { side: 'SIDE_SELL', escrow: '200000000', sealed: false } });
    expect(toWire(row('CrossCleared', { cross: 'C', printed: true, clearing: { __option: 'Some', value: { price: '1550000', matched: '100000000', rationed: 2 } }, noPrintReason: { __option: 'None' } }))).toMatchObject({ cross_cleared: { printed: true, price: '1550000', matched: '100000000', rationed: 'sell' } });
    expect(toWire(row('CrossCleared', { cross: 'C', printed: false, clearing: { __option: 'None' }, noPrintReason: { __option: 'Some', value: 1 } }))).toMatchObject({ cross_cleared: { printed: false, no_print_reason: 'below-minimum-volume' } });
    expect(toWire(row('OrderClaimed', { cross: 'C', order: 'O', owner: 'W', side: 0, fill: '5', quoteOut: '10', baseOut: '5', fee: '1' }))).toMatchObject({ order_claimed: { side: 'SIDE_BUY', quote_out: '10', fee: '1' } });
    expect(toWire(row('CrossFinalized', { cross: 'C', protocolFee: '1', integratorFee: '2', proceedsQuote: '3', dustBase: '4' }))).toMatchObject({ cross_finalized: { proceeds_quote: '3', dust_base: '4' } });
    expect(toWire(row('PauseChanged', { paused: true }))).toMatchObject({ pause_changed: { paused: true } });
    expect(() => toWire(row('SomethingNew', {}))).toThrow(/no message/);
    expect(() => toWire(row('CrossCreated', { ...created('C'), kind: 99 }))).toThrow(/not known to this build/);
  });
});

describe('Subscribe', () => {
  it('replays the whole log in order, starting with a heartbeat that says where the log ends', async () => {
    const src = new MemorySource();
    src.push('CrossCreated', CROSS_A, created(CROSS_A));
    src.push('OrderCommitted', CROSS_A, committed(CROSS_A, 'O1'));
    src.push('OrderCommitted', CROSS_A, committed(CROSS_A, 'O2'));
    const { client } = await start(src);
    const msgs = await take(client.subscribe(), 4, 'any');
    expect(msgs[0]).toMatchObject({ body: 'heartbeat', heartbeat: { head: { position: '3' } } });
    expect(msgs.slice(1).map((m) => [m.event!.cursor.position, m.event!.name])).toEqual([['1', 'CrossCreated'], ['2', 'OrderCommitted'], ['3', 'OrderCommitted']]);
    expect(msgs[1]!.event).toMatchObject({ payload: 'cross_created', cross: CROSS_A, signature: 'sig1', block_time: '1800000001' });
  });

  it('resumes after a cursor: nothing missed, nothing twice', async () => {
    const src = new MemorySource();
    for (let i = 0; i < 6; i++) src.push('OrderCommitted', CROSS_A, committed(CROSS_A, `O${i}`));
    const { client } = await start(src);
    const first = await take(client.subscribe(), 3);
    const cursor = first[2]!.event!.cursor.position;
    const rest = await take(client.subscribe({ from: cursor }), 3);
    expect([...first, ...rest].map((m) => m.event!.cursor.position)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('filters by cross and by event name', async () => {
    const src = new MemorySource();
    src.push('CrossCreated', CROSS_A, created(CROSS_A));
    src.push('CrossCreated', CROSS_B, created(CROSS_B));
    src.push('OrderCommitted', CROSS_B, committed(CROSS_B, 'O1'));
    src.push('OrderCommitted', CROSS_A, committed(CROSS_A, 'O2'));
    const { client } = await start(src);
    expect((await take(client.subscribe({ crosses: [CROSS_B] }), 2)).map((m) => m.event!.name)).toEqual(['CrossCreated', 'OrderCommitted']);
    expect((await take(client.subscribe({ events: ['OrderCommitted'] }), 2)).map((m) => m.event!.cross)).toEqual([CROSS_B, CROSS_A]);
    expect((await take(client.subscribe({ crosses: [CROSS_A], events: ['OrderCommitted'] }), 1))[0]!.event!.order_committed).toMatchObject({ order: 'O2' });
  });

  it('follows the log: events appended after the subscription arrive, and fromHead skips the history', async () => {
    const src = new MemorySource();
    src.push('CrossCreated', CROSS_A, created(CROSS_A));
    const { client } = await start(src);
    const sub = client.subscribe({ fromHead: true });
    const got = take(sub, 2);
    setTimeout(() => {
      src.push('OrderCommitted', CROSS_A, committed(CROSS_A, 'late1'));
      src.push('OrderCommitted', CROSS_A, committed(CROSS_A, 'late2'));
    }, 60);
    expect((await got).map((m) => m.event!.cursor.position)).toEqual(['2', '3']);
  });

  it('sends heartbeats while quiet and stops reading the log when the client goes away', async () => {
    const src = new MemorySource();
    const { client } = await start(src);
    const beats = await take(client.subscribe(), 3, 'any');
    expect(beats.every((m) => m.body === 'heartbeat')).toBe(true);
    const before = src.reads;
    await new Promise((r) => setTimeout(r, 120));
    expect(src.reads - before).toBeLessThanOrEqual(2); // the loop ended with the call
  });

  it('ends with UNAVAILABLE when the log cannot be read, and with INTERNAL naming an event it cannot convert', async () => {
    const src = new MemorySource();
    const { client } = await start(src);
    src.failNext = true;
    await expect(take(client.subscribe(), 1)).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    src.failNext = false;
    src.push('FromTheFuture', CROSS_A, {});
    await expect(take(client.subscribe(), 1)).rejects.toMatchObject({ code: grpc.status.INTERNAL, details: expect.stringContaining('position 1') });
  });

  it('disconnects a client that does not read, so the server never buffers without bound', async () => {
    const src = new MemorySource();
    const big = 'x'.repeat(400);
    for (let i = 0; i < 20_000; i++) src.push('OrderCommitted', CROSS_A, { ...committed(CROSS_A, `O${i}${big}`) });
    const { client } = await start(src, { stallMs: 100 });
    const stream = client.subscribe();
    const it = stream[Symbol.asyncIterator]();
    await it.next(); // the heartbeat; then the client stops reading
    await new Promise((r) => setTimeout(r, 1_500));
    const drained: WireMessage[] = [];
    let error: { code?: number } | null = null;
    try {
      for (let i = 0; i < 25_000; i++) {
        const n = await it.next();
        if (n.done) break;
        drained.push(n.value);
      }
    } catch (e) {
      error = e as { code?: number };
    }
    expect(error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(drained.length).toBeLessThan(20_000);
  }, 60_000);
});

describe('Head and the bearer token', () => {
  it('Head reports the end of the log', async () => {
    const src = new MemorySource();
    src.push('CrossCreated', CROSS_A, created(CROSS_A));
    src.push('PauseChanged', null, { paused: false });
    const { client } = await start(src);
    expect(await client.head()).toEqual({ head: { position: '2' }, events: '2' });
  });

  it('refuses a call without the token and serves one with it', async () => {
    const src = new MemorySource();
    src.push('PauseChanged', null, { paused: true });
    const { client } = await start(src, { token: 'secret-token-123' });
    await expect(client.head()).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    await expect(take(client.subscribe({ token: 'wrong' }), 1)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    expect(await client.head('secret-token-123')).toMatchObject({ events: '1' });
    expect((await take(client.subscribe({ token: 'secret-token-123' }), 1))[0]!.event!.name).toBe('PauseChanged');
  });
});
