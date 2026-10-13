import { describe, expect, it } from 'vitest';
import { AllEndpointsFailed, EndpointPool, FailoverRpc, RpcCallError, computeBudgetInstructions, estimatePriorityFee, landTransaction, landWithRetries, percentileOf, priorityFeeLamports, signatureOf, unitLimitFor } from '../src/index.js';

type Reply = { status?: number; headers?: Record<string, string>; json?: unknown; throws?: string; delayMs?: number };
type Handler = (method: string, params: unknown[], url: string) => Reply;

/** A network of named endpoints, each answering by a handler. Counts calls per URL and method. */
function network(handlers: Record<string, Handler>) {
  const calls: { url: string; method: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body)) as { method: string; params: unknown[]; id: number };
    calls.push({ url, method });
    const h = handlers[url];
    if (!h) throw new Error('connect ECONNREFUSED');
    const r = h(method, params, url);
    if (r.delayMs) {
      // Like a real fetch, give up when the caller aborts.
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, r.delayMs);
        init.signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
      });
    }
    if (r.throws) throw new Error(r.throws);
    const body = r.json === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id, ...(r.json as object) });
    return new Response(body, { status: r.status ?? 200, ...(r.headers ? { headers: r.headers } : {}) });
  }) as unknown as typeof fetch;
  return { f, calls, count: (url: string, method?: string) => calls.filter((c) => c.url === url && (!method || c.method === method)).length };
}

const ok = (result: unknown): Reply => ({ json: { result } });
const A = 'https://a.test';
const B = 'https://b.test';
const C = 'https://c.test';

describe('EndpointPool', () => {
  it('keeps the operator order until it has evidence, then prefers the faster, more reliable endpoint', () => {
    const p = new EndpointPool([A, B]);
    expect(p.order()).toEqual([A, B]);
    for (let i = 0; i < 10; i++) {
      p.record(A, { kind: 'ok', ms: 900 });
      p.record(B, { kind: 'ok', ms: 80 });
    }
    expect(p.order()).toEqual([B, A]);
  });

  it('rests a rate-limited endpoint for as long as it asked, then brings it back', () => {
    let t = 1_000;
    const p = new EndpointPool([A, B], { now: () => t });
    p.record(A, { kind: 'rate-limited', retryAfterMs: 5_000 });
    expect(p.order()).toEqual([B, A]);
    t += 4_999;
    expect(p.order()[0]).toBe(B);
    t += 2;
    // Usable again, but it was just rate limited, so it ranks behind the endpoint that has been answering; one good answer restores the order.
    expect(p.snapshot()[0]!.cooldownUntil).toBeLessThanOrEqual(t);
    expect(p.order()).toEqual([B, A]);
    for (let i = 0; i < 8; i++) p.record(A, { kind: 'ok', ms: 300 });
    expect(p.order()[0]).toBe(A);
  });

  it('forgives one failure and rests an endpoint that fails twice in a row, for longer each time, up to a cap', () => {
    let t = 0;
    const p = new EndpointPool([A, B], { now: () => t, maxCooldownMs: 10_000 });
    p.record(A, { kind: 'failed', reason: 'HTTP 502' });
    expect(p.snapshot()[0]!.cooldownUntil).toBe(0);
    p.record(A, { kind: 'failed', reason: 'HTTP 502' });
    expect(p.snapshot()[0]!.cooldownUntil).toBe(2_000);
    for (let i = 0; i < 10; i++) p.record(A, { kind: 'failed', reason: 'HTTP 502' });
    expect(p.snapshot()[0]!.cooldownUntil).toBe(10_000);
    p.record(A, { kind: 'ok', ms: 100 });
    expect(p.snapshot()[0]!.cooldownUntil).toBe(0);
  });

  it('sets aside an endpoint that is far behind the cluster, and falls back to it only when nothing else is left', () => {
    const p = new EndpointPool([A, B]);
    p.recordSlots(new Map([[A, 1_000], [B, 1_200]]));
    expect(p.order()).toEqual([B, A]);
    p.record(B, { kind: 'rate-limited' });
    expect(p.order()).toEqual([A, B]); // A lags, B cools down: the one back soonest is not necessarily first
  });

  it('refuses an empty list and an unknown endpoint', () => {
    expect(() => new EndpointPool([])).toThrow(/at least one/);
    expect(() => new EndpointPool([A]).record('https://nope', { kind: 'ok', ms: 1 })).toThrow(/unknown endpoint/);
  });
});

describe('FailoverRpc', () => {
  it('answers from the first endpoint when it is healthy and does not touch the others', async () => {
    const n = network({ [A]: () => ok(42), [B]: () => ok(0) });
    const rpc = new FailoverRpc([A, B], { fetch: n.f });
    expect(await rpc.call('getSlot')).toBe(42);
    expect(n.count(B)).toBe(0);
  });

  it('moves to the next endpoint on a 429, a 503, a dead connection, a timeout and an unhealthy-node error', async () => {
    const n = network({
      [A]: () => ({ status: 429, headers: { 'retry-after': '2' } }),
      [B]: () => ({ status: 503 }),
      [C]: () => ok('from c'),
    });
    const rpc = new FailoverRpc([A, B, C, 'https://dead.test'], { fetch: n.f });
    expect(await rpc.call('getHealth')).toBe('from c');
    const s = rpc.pool.snapshot();
    expect(s[0]!.rateLimited).toBe(1);
    expect(s[0]!.cooldownUntil).toBeGreaterThan(Date.now());
    expect(s[1]!.lastError).toBe('HTTP 503');

    const n2 = network({ [A]: () => ({ json: { error: { code: -32005, message: 'Node is behind by 120 slots' } } }), [B]: () => ok(1) });
    expect(await new FailoverRpc([A, B], { fetch: n2.f }).call('getSlot')).toBe(1);

    const nk = network({ [A]: () => ({ json: { error: { code: -32000, message: 'Unauthorized: You must authenticate your request with an API key' } } }), [B]: () => ok('with key') });
    expect(await new FailoverRpc([A, B], { fetch: nk.f }).call('getSlot')).toBe('with key');
    const n3 = network({ [A]: () => ({ delayMs: 200, json: { result: 'late' } }), [B]: () => ok('quick') });
    expect(await new FailoverRpc([A, B], { fetch: n3.f, timeoutMs: 20 }).call('getSlot')).toBe('quick');
  });

  it('returns the cluster\'s own error instead of asking every endpoint the same wrong question', async () => {
    const n = network({ [A]: () => ({ json: { error: { code: -32002, message: 'Transaction simulation failed', data: { logs: ['x'] } } } }), [B]: () => ok('never') });
    const rpc = new FailoverRpc([A, B], { fetch: n.f });
    await expect(rpc.call('simulateTransaction')).rejects.toMatchObject({ name: 'RpcCallError', code: -32002, data: { logs: ['x'] } });
    expect(n.count(B)).toBe(0);
    expect(RpcCallError.name).toBe('RpcCallError');
  });

  it('says what each endpoint did when none can answer, and goes another round when asked', async () => {
    const n = network({ [A]: () => ({ status: 429 }), [B]: () => ({ status: 500 }) });
    const rpc = new FailoverRpc([A, B], { fetch: n.f, rounds: 2, sleep: async () => {} });
    const err = await rpc.call('getSlot').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllEndpointsFailed);
    expect((err as AllEndpointsFailed).attempts).toHaveLength(4);
    expect((err as Error).message).toContain('a.test: rate limited');
    expect((err as Error).message).toContain('b.test: HTTP 500');
  });

  it('hedges a slow read: the second endpoint answers while the first is still thinking', async () => {
    const n = network({ [A]: () => ({ delayMs: 300, json: { result: 'slow' } }), [B]: () => ok('fast') });
    const rpc = new FailoverRpc([A, B], { fetch: n.f, hedgeAfterMs: 20 });
    const t = Date.now();
    expect(await rpc.call('getAccountInfo')).toBeDefined();
    expect(Date.now() - t).toBeLessThan(250 + 300);
    expect(n.count(B, 'getAccountInfo')).toBe(1);
  });

  it('never hedges a send', async () => {
    const n = network({ [A]: () => ({ delayMs: 60, json: { result: 'sig' } }), [B]: () => ok('sig2') });
    const rpc = new FailoverRpc([A, B], { fetch: n.f, hedgeAfterMs: 10 });
    expect(await rpc.call('sendTransaction')).toBe('sig');
    expect(n.count(B)).toBe(0);
  });

  it('serves code that wants a fetch, mapping a total outage to 503 and a total rate limit to 429', async () => {
    const good = network({ [A]: () => ok(7) });
    const f = new FailoverRpc([A], { fetch: good.f }).asFetch();
    const body = (await (await f('ignored', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'getSlot', params: [] }) })).json()) as { id: number; result: number };
    expect(body).toMatchObject({ id: 9, result: 7 });

    const down = new FailoverRpc([A], { fetch: network({ [A]: () => ({ status: 500 }) }).f }).asFetch();
    expect((await down('x', { method: 'POST', body: JSON.stringify({ method: 'getSlot' }) })).status).toBe(503);
    const limited = new FailoverRpc([A, B], { fetch: network({ [A]: () => ({ status: 429 }), [B]: () => ({ status: 429 }) }).f }).asFetch();
    expect((await limited('x', { method: 'POST', body: JSON.stringify({ method: 'getSlot' }) })).status).toBe(429);
  });

  it('probes every endpoint for its slot and then stops using the one that is far behind', async () => {
    const n = network({ [A]: () => ok(500), [B]: () => ok(900) });
    const rpc = new FailoverRpc([A, B], { fetch: n.f });
    const slots = await rpc.probe();
    expect([...slots.values()]).toEqual([500, 900]);
    expect(rpc.pool.order()).toEqual([B, A]);
    expect(rpc.pool.snapshot()[0]!.slotLag).toBe(400);
  });
});

describe('priority fees', () => {
  it('takes a percentile of recent fees for the accounts, within a cap', async () => {
    const fees = Array.from({ length: 20 }, (_, i) => ({ slot: i, prioritizationFee: i < 10 ? 0 : (i - 9) * 1_000 }));
    const rpc = { call: async () => fees } as never;
    expect(await estimatePriorityFee(rpc, ['acct'], { percentile: 0.55 })).toEqual({ microLamports: 1_000n, basis: 'recent-fees', samples: 20 });
    const p90 = await estimatePriorityFee(rpc, ['acct'], { percentile: 0.95, computeUnits: 200_000 });
    expect(p90.microLamports).toBe(9_000n);
    const capped = await estimatePriorityFee(rpc, ['acct'], { percentile: 1, maxTotalLamports: 500n, computeUnits: 200_000 });
    expect(capped).toMatchObject({ basis: 'capped', microLamports: 2_500n }); // 500 lamports over 200,000 units
    expect(priorityFeeLamports(200_000, 2_500n)).toBe(500n);
  });

  it('falls back to the floor when the cluster has nothing to say or cannot be asked', async () => {
    expect(await estimatePriorityFee({ call: async () => [] } as never, ['a'], { floor: 50n })).toEqual({ microLamports: 50n, basis: 'floor', samples: 0 });
    expect(await estimatePriorityFee({ call: async () => { throw new Error('down'); } } as never, ['a'])).toMatchObject({ microLamports: 0n, basis: 'floor' });
  });

  it('encodes the two compute-budget instructions the way the program reads them', () => {
    const [limit, price] = computeBudgetInstructions(300_000, 1_234n);
    expect([...limit!.data]).toEqual([2, 0xe0, 0x93, 0x04, 0x00]);
    expect(price!.data[0]).toBe(3);
    expect(new DataView(price!.data.buffer).getBigUint64(1, true)).toBe(1_234n);
    expect(limit!.programAddress).toBe('ComputeBudget111111111111111111111111111111');
  });

  it('sizes the unit limit from a simulation, with headroom and bounds', () => {
    expect(unitLimitFor(100_000)).toBe(115_000);
    expect(unitLimitFor(10)).toBe(5_000);
    expect(unitLimitFor(2_000_000)).toBe(1_400_000);
    expect(unitLimitFor(null)).toBe(200_000);
    expect(percentileOf([3n, 1n, 2n], 0.5)).toBe(2n);
    expect(percentileOf([], 0.5)).toBe(0n);
  });
});

describe('landing', () => {
  const wire = Uint8Array.from([1, ...Array.from({ length: 64 }, (_, i) => i + 1), 0, 0, 0]);
  const sig = signatureOf(wire);
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('resends until the transaction is seen, then reports where and when it landed', async () => {
    const c = clock();
    let polls = 0;
    const n = network({
      [A]: (m) => (m === 'sendTransaction' ? ok(sig) : m === 'getSignatureStatuses' ? ok({ value: [++polls < 6 ? null : { err: null, confirmationStatus: 'confirmed', slot: 777 }] }) : ok(100)),
      [B]: (m) => (m === 'sendTransaction' ? ok(sig) : ok(100)),
    });
    const r = await landTransaction(new FailoverRpc([A, B], { fetch: n.f }), wire, 500n, { ...c });
    expect(r).toMatchObject({ status: 'landed', slot: 777, signature: sig });
    expect(r.sends).toBeGreaterThan(1); // 800 ms polls, 2 s resends
    expect(r.accepted.sort()).toEqual([A, B]);
    expect(n.count(B, 'sendTransaction')).toBe(r.sends);
  });

  it('reports a transaction that failed on chain with the cluster\'s error', async () => {
    const c = clock();
    const err = { InstructionError: [0, { Custom: 3012 }] };
    const n = network({ [A]: (m) => (m === 'sendTransaction' ? ok(sig) : m === 'getSignatureStatuses' ? ok({ value: [{ err, confirmationStatus: 'confirmed', slot: 5 }] }) : ok(1)) });
    expect(await landTransaction(new FailoverRpc([A], { fetch: n.f }), wire, 500n, { ...c })).toMatchObject({ status: 'failed', err });
  });

  it('gives up on the first send when every route says the transaction is wrong, after one look at whether it landed', async () => {
    const c = clock();
    const bad = (m: string): Reply => (m === 'sendTransaction' ? { json: { error: { code: -32002, message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit. insufficient funds' } } } : ok({ value: [null] }));
    const n = network({ [A]: bad, [B]: bad });
    const r = await landTransaction(new FailoverRpc([A, B], { fetch: n.f }), wire, 500n, { ...c });
    expect(r.status).toBe('failed');
    expect(String(r.err)).toContain('insufficient funds');
    expect(r.sends).toBe(1);
  });

  it('keeps resending through a node that has not yet seen a fresh blockhash', async () => {
    const c = clock();
    let sends = 0;
    const n = network({
      [A]: (m) => {
        if (m === 'sendTransaction') return ++sends < 3 ? { json: { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found' } } } : ok(sig);
        if (m === 'getSignatureStatuses') return ok({ value: [sends >= 3 ? { err: null, confirmationStatus: 'confirmed', slot: 4 } : null] });
        return ok(100);
      },
    });
    expect(await landTransaction(new FailoverRpc([A], { fetch: n.f }), wire, 500n, { ...c })).toMatchObject({ status: 'landed', sends: 3 });
  });

  it('calls a transaction expired only after the block height passes and a last look through history finds nothing', async () => {
    const c = clock();
    let height = 498;
    const history: boolean[] = [];
    const n = network({
      [A]: (m, p) => {
        if (m === 'sendTransaction') return ok(sig);
        if (m === 'getBlockHeight') return ok(height++);
        if (m === 'getSignatureStatuses') {
          history.push((p[1] as { searchTransactionHistory: boolean }).searchTransactionHistory);
          return ok({ value: [null] });
        }
        return ok(0);
      },
    });
    const r = await landTransaction(new FailoverRpc([A], { fetch: n.f }), wire, 500n, { ...c });
    expect(r.status).toBe('expired');
    expect(history.at(-1)).toBe(true);
  });

  it('counts a transaction that landed just before the blockhash died as landed', async () => {
    const c = clock();
    const n = network({
      [A]: (m, p) => {
        if (m === 'sendTransaction') return ok(sig);
        if (m === 'getBlockHeight') return ok(501);
        const history = (p[1] as { searchTransactionHistory: boolean }).searchTransactionHistory;
        return ok({ value: [history ? { err: null, confirmationStatus: 'finalized', slot: 9 } : null] });
      },
    });
    expect(await landTransaction(new FailoverRpc([A], { fetch: n.f }), wire, 500n, { ...c })).toMatchObject({ status: 'landed', slot: 9 });
  });

  it('rebuilds at a higher fee after an expiry, never exceeds the ceiling, and does not rebuild one that landed', async () => {
    const c = clock();
    const fees: bigint[] = [];
    const landedOn = 3; // the third build lands
    let build = 0;
    const wires = [0, 1, 2, 3].map((k) => Uint8Array.from([1, ...Array.from({ length: 64 }, (_, i) => (i + k * 7) % 250 + 1), 0]));
    const n = network({
      [A]: (m, p) => {
        if (m === 'sendTransaction') return ok('x');
        if (m === 'getBlockHeight') return ok(10_000);
        const sigNow = (p[0] as string[])[0];
        const winner = signatureOf(wires[landedOn - 1]!);
        return ok({ value: [sigNow === winner ? { err: null, confirmationStatus: 'confirmed', slot: 1 } : null] });
      },
    });
    const r = await landWithRetries(
      new FailoverRpc([A], { fetch: n.f }),
      async (fee) => {
        fees.push(fee);
        return { wire: wires[build++]!, lastValidBlockHeight: 500n };
      },
      { ...c, microLamports: 1_000n, maxMicroLamports: 3_000n, maxBuilds: 4 },
    );
    expect(r.status).toBe('landed');
    expect(fees).toEqual([1_000n, 2_000n, 3_000n]); // doubled, then capped
    expect(r.attempts.map((a) => a.status)).toEqual(['expired', 'expired', 'landed']);
    expect(build).toBe(3);
  });

  it('stops after the most builds allowed and says the last one expired', async () => {
    const c = clock();
    const n = network({ [A]: (m) => (m === 'sendTransaction' ? ok('x') : m === 'getBlockHeight' ? ok(10_000) : ok({ value: [null] })) });
    let k = 0;
    const r = await landWithRetries(new FailoverRpc([A], { fetch: n.f }), async () => ({ wire: Uint8Array.from([1, ...Array.from({ length: 64 }, () => ++k % 200 + 1), 0]), lastValidBlockHeight: 5n }), { ...c, microLamports: 0n, maxMicroLamports: 10_000n, maxBuilds: 2 });
    expect(r.status).toBe('expired');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[1]!.microLamports).toBe(2_000n); // from zero, escalation starts at 1,000 then doubles
  });
});
