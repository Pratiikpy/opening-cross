import { getAddressEncoder, address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  CROSS_CORE,
  EXTERNAL_PROGRAMS,
  OWN_PROGRAMS,
  UPGRADEABLE_LOADER,
  authorityKind,
  decodeProgramAccount,
  decodeProgramData,
  decodeProtocol,
  protocolAddress,
  readPower,
  readPrograms,
  rpcBatch,
} from '../src/lib/power';

const enc = (a: string) => new Uint8Array(getAddressEncoder().encode(address(a)));
const ADMIN = '4amt9nP6nCFHKG6TyXCUGTZtjyURaqXhKJQVFYZFmdS3';
const GUARD = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const FEES = '22eBxH5mXpFk3NboAgReTkeNwvgerdKAeNWsrNmDy8Ta';
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

function protocolBytes(opts: { paused?: boolean; pending?: string | null } = {}): Uint8Array {
  const out = new Uint8Array(8 + 96 + 8 + 2 + 33);
  out.set(enc(ADMIN), 8);
  out.set(enc(GUARD), 40);
  out.set(enc(FEES), 72);
  const v = new DataView(out.buffer);
  [30, 5, 15, 5].forEach((b, i) => v.setUint16(104 + i * 2, b, true));
  out[112] = opts.paused ? 1 : 0;
  out[113] = 254;
  if (opts.pending) {
    out[114] = 1;
    out.set(enc(opts.pending), 115);
  }
  return out;
}

describe('decoders', () => {
  it('reads the protocol account: admin, guardian, fee recipient, fees, pause, pending admin', () => {
    const p = decodeProtocol(protocolBytes({ paused: true, pending: GUARD }))!;
    expect(p).toEqual({ admin: ADMIN, guardian: GUARD, feeRecipient: FEES, feeBps: [30, 5, 15, 5], paused: true, pendingAdmin: GUARD });
    expect(decodeProtocol(protocolBytes())!.pendingAdmin).toBeNull();
    expect(decodeProtocol(new Uint8Array(20))).toBeNull();
  });

  it('reads the program account and the ProgramData account of the upgradeable loader', () => {
    const prog = new Uint8Array(36);
    new DataView(prog.buffer).setUint32(0, 2, true);
    prog.set(enc(ADMIN), 4);
    expect(decodeProgramAccount(prog)).toBe(ADMIN);
    expect(decodeProgramAccount(new Uint8Array(36))).toBeNull();

    const pd = new Uint8Array(45);
    const v = new DataView(pd.buffer);
    v.setUint32(0, 3, true);
    v.setBigUint64(4, 510_000_000n, true);
    pd[12] = 1;
    pd.set(enc(GUARD), 13);
    expect(decodeProgramData(pd)).toEqual({ slot: 510_000_000n, authority: GUARD });
    pd[12] = 0;
    expect(decodeProgramData(pd)).toEqual({ slot: 510_000_000n, authority: null });
    pd[12] = 7;
    expect(decodeProgramData(pd)).toBeNull();
  });

  it('tells a wallet key from a program-controlled address', async () => {
    expect(authorityKind(null)).toBe('none');
    expect(authorityKind(ADMIN)).toBe('key');
    expect(authorityKind(await protocolAddress())).toBe('program'); // a PDA is off the curve
  });
});

/** A fake RPC node answering getMultipleAccounts from a script keyed by account address; it records each call. */
const node = (answers: Record<string, unknown>, calls: string[][] = []) => async (_u: string, init: RequestInit) => {
  const req = JSON.parse(String(init.body)) as { method: string; params: [string[]] };
  if (Array.isArray(req)) return new Response('batches are refused', { status: 429 });
  expect(req.method).toBe('getMultipleAccounts');
  calls.push(req.params[0]);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: req.params[0].map((k) => answers[k] ?? null) } }));
};
const acct = (owner: string, data: Uint8Array, executable = true) => ({ owner, executable, data: [b64(data), 'base64'] });

describe('rpcBatch', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
  it('retries a 429 (honouring Retry-After) and then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await rpcBatch('http://rpc.test', [{ method: 'getSlot', params: [] }], {
      sleep: async (ms) => void waits.push(ms),
      fetcher: async () => (++calls < 3 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : ok(42)),
    });
    expect(out).toEqual([42]);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('retries a rate limit reported inside a 200 and a dropped connection', async () => {
    let calls = 0;
    const out = await rpcBatch('http://rpc.test', [{ method: 'm', params: [] }], {
      sleep: async () => {},
      fetcher: async () => {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed');
        if (calls === 2) return new Response(JSON.stringify({ error: { code: 429, message: 'Too many requests' } }));
        return ok('fine');
      },
    });
    expect(out).toEqual(['fine']);
  });

  it('gives up with a clear message instead of an answer it does not have', async () => {
    await expect(rpcBatch('http://rpc.test', [{ method: 'm', params: [] }], { attempts: 2, sleep: async () => {}, fetcher: async () => new Response('', { status: 429 }) })).rejects.toThrow(/HTTP 429 after 2 attempts/);
  });

  it('sends one call per request (never a JSON-RPC batch), keeps results in request order, and surfaces real RPC errors', async () => {
    const bodies: string[] = [];
    const out = await rpcBatch('http://rpc.test', [{ method: 'a', params: ['x'] }, { method: 'b', params: ['y'] }, { method: 'c', params: ['z'] }], {
      fetcher: async (_u, init) => {
        const b = JSON.parse(String(init.body)) as { method: string };
        bodies.push(String(init.body));
        return ok(b.method.toUpperCase());
      },
    });
    expect(out).toEqual(['A', 'B', 'C']);
    expect(bodies.every((b) => !b.startsWith('['))).toBe(true);
    await expect(rpcBatch('http://rpc.test', [{ method: 'a', params: [] }], { fetcher: async () => new Response(JSON.stringify({ error: { code: -32602, message: 'Invalid param' } })) })).rejects.toThrow('Invalid param');
  });
});

describe('readPrograms', () => {
  it('follows a program to its ProgramData and reports the authority; handles missing and non-upgradeable programs', async () => {
    const prog = new Uint8Array(36);
    new DataView(prog.buffer).setUint32(0, 2, true);
    prog.set(enc(GUARD), 4);
    const pd = new Uint8Array(45);
    new DataView(pd.buffer).setUint32(0, 3, true);
    pd[12] = 1;
    pd.set(enc(ADMIN), 13);
    const seen: string[][] = [];
    const res = await readPrograms('http://rpc.test', [CROSS_CORE, 'MissingMissingMissingMissingMissingMissing11', 'BPFLoader2111111111111111111111111111111111'], {
      fetcher: node({ [CROSS_CORE]: acct(UPGRADEABLE_LOADER, prog), BPFLoader2111111111111111111111111111111111: acct('BPFLoader2111111111111111111111111111111111', new Uint8Array(36)), [GUARD]: acct(UPGRADEABLE_LOADER, pd) }, seen),
    });
    expect(res[0]).toMatchObject({ found: true, upgradeable: true, authority: ADMIN, kind: 'key' });
    expect(res[1]).toEqual({ id: 'MissingMissingMissingMissingMissingMissing11', found: false });
    expect(res[2]).toMatchObject({ found: true, upgradeable: false });
    expect(seen).toHaveLength(2); // the program accounts in one call, then the ProgramData accounts in one call
  });
});

describe('readPower', () => {
  it('reads every program and the protocol account', async () => {
    const prog = new Uint8Array(36);
    new DataView(prog.buffer).setUint32(0, 2, true);
    prog.set(enc(GUARD), 4);
    const pd = new Uint8Array(45);
    new DataView(pd.buffer).setUint32(0, 3, true);
    pd[12] = 1;
    pd.set(enc(ADMIN), 13);
    const pda = await protocolAddress();
    const calls: string[][] = [];
    const res = await readPower('http://rpc.test', [CROSS_CORE], {
      fetcher: node({ [CROSS_CORE]: acct(UPGRADEABLE_LOADER, prog), [pda]: acct(CROSS_CORE, protocolBytes({ pending: GUARD }), false), [GUARD]: acct(UPGRADEABLE_LOADER, pd) }, calls),
    });
    expect(calls).toHaveLength(2);
    expect(res.programs[0]).toMatchObject({ authority: ADMIN, kind: 'key' });
    expect(res.protocol?.protocol).toMatchObject({ admin: ADMIN, guardian: GUARD, pendingAdmin: GUARD });
  });
});

describe('the program lists', () => {
  it('match Anchor.toml for our five programs and have unique addresses', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../../../Anchor.toml', import.meta.url), 'utf8');
    const devnet = toml.split('[programs.devnet]')[1]!.split('[')[0]!;
    for (const p of OWN_PROGRAMS) expect(devnet).toContain(`${p.name} = "${p.id}"`);
    expect(OWN_PROGRAMS).toHaveLength(5);
    const ids = [...OWN_PROGRAMS, ...EXTERNAL_PROGRAMS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
