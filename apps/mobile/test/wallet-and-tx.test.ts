import { describe, expect, it } from 'vitest';
import { accountAddress, base58Encode, chainFor } from '../src/lib/address';
import { base64ToBytes, bytesToBase64, bytesToHex } from '../src/lib/base64';
import { ActionError, build, signSendConfirm } from '../src/lib/tx';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** An independent decoder (BigInt arithmetic) to check the encoder against. */
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  const zeros = [...s].findIndex((c) => c !== '1');
  return Uint8Array.from([...new Array(zeros === -1 ? s.length : zeros).fill(0), ...bytes]);
}

describe('addresses', () => {
  it('encodes base58 like the reference, for known and random keys', () => {
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111'); // the System Program
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(base58Encode(base58Decode(usdc))).toBe(usdc);
    let seed = 7;
    for (let i = 0; i < 200; i++) {
      const b = Uint8Array.from({ length: 32 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255);
      if (i % 5 === 0) b[0] = 0;
      expect(Array.from(base58Decode(base58Encode(b)))).toEqual(Array.from(b));
    }
  });

  it('reads a wallet account in either shape and refuses a malformed one', () => {
    const key = base58Decode('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    expect(accountAddress({ address: bytesToBase64(key) })).toBe('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    expect(accountAddress({ address: 'ignored', publicKey: key })).toBe('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    expect(() => accountAddress({ address: bytesToBase64(new Uint8Array(31)) })).toThrow(/32 bytes/);
    expect(() => accountAddress({ address: '***' })).toThrow();
  });

  it('asks the wallet for the chain identifiers the specification defines', () => {
    expect(chainFor('devnet')).toBe('solana:devnet');
    expect(chainFor('mainnet-beta')).toBe('solana:mainnet');
    expect(chainFor('testnet')).toBe('solana:testnet');
  });
});

describe('base64', () => {
  it('matches Node for every length and rejects junk', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
      expect(Array.from(base64ToBytes(Buffer.from(b).toString('base64')))).toEqual(Array.from(b));
    }
    for (const bad of ['abc', 'a=bc', 'ab!d', '====']) expect(() => base64ToBytes(bad)).toThrow();
    expect(bytesToHex(Uint8Array.from([0, 15, 255]))).toBe('000fff');
  });
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('build', () => {
  it('returns every transaction the API sends, one or many', async () => {
    const one = await build('/v1/tx/place-order', { a: 1 }, { fetchImpl: async () => ok({ transaction: 'AAAA', signers: ['x'], order: 'O' }), apiUrl: 'http://api' });
    expect(one.txs).toEqual([{ transaction: 'AAAA', signers: ['x'] }]);
    expect(one.extra.order).toBe('O');
    const many = await build('/v1/tx/settle', {}, { fetchImpl: async () => ok({ transactions: [{ transaction: 'AAAA', signers: [] }, { transaction: 'BBBB', signers: [] }] }) });
    expect(many.txs).toHaveLength(2);
  });

  it('posts JSON to the API url and refuses in plain words', async () => {
    let seen: { url: string; body: string } | null = null;
    await build('/v1/tx/cancel', { cross: 'c', nonce: '5' }, { apiUrl: 'http://api', fetchImpl: async (url, init) => ((seen = { url: String(url), body: String(init?.body) }), ok({ transaction: 'AAAA', signers: [] })) });
    expect(seen).toEqual({ url: 'http://api/v1/tx/cancel', body: '{"cross":"c","nonce":"5"}' });
    await expect(build('/x', {}, { fetchImpl: async () => ok({ error: 'cross is not accepting orders' }, 409) })).rejects.toThrow('cross is not accepting orders');
    await expect(build('/x', {}, { fetchImpl: async () => ok({}) })).rejects.toThrow('no transaction to sign');
    await expect(build('/x', {}, { fetchImpl: async () => { throw new Error('offline'); } })).rejects.toThrow('could not be reached');
  });
});

describe('signSendConfirm', () => {
  const tx = [{ transaction: 'AAAA', signers: [] }];
  /** A scripted RPC: sendTransaction returns a signature, getSignatureStatuses walks through the given states. */
  const rpc = (states: unknown[], sendError?: object) => {
    const calls: string[] = [];
    const fetchImpl = async (_u: unknown, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      calls.push(method);
      if (method === 'sendTransaction') return ok(sendError ? { error: sendError } : { result: 'SIG' });
      return ok({ result: { value: [states.shift() ?? null] } });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  };
  const fast = { sleep: async () => undefined };

  it('signs once for all transactions, sends each, and waits for confirmation', async () => {
    const { fetchImpl, calls } = rpc([null, { err: null, confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'confirmed' }]);
    let asked: string[] = [];
    const steps: string[] = [];
    const sigs = await signSendConfirm(tx, async (t) => ((asked = t), ['BBBB']), (s) => steps.push(s), { fetchImpl, ...fast });
    expect(asked).toEqual(['AAAA']);
    expect(sigs).toEqual(['SIG']);
    expect(calls).toEqual(['sendTransaction', 'getSignatureStatuses', 'getSignatureStatuses', 'getSignatureStatuses']);
    expect(steps[0]).toBe('Waiting for your wallet…');
  });

  it('says so when the user declines, and sends nothing', async () => {
    const { fetchImpl, calls } = rpc([]);
    await expect(signSendConfirm(tx, async () => { throw new Error('User declined the request'); }, undefined, { fetchImpl })).rejects.toThrow('You declined in your wallet. Nothing was sent.');
    expect(calls).toEqual([]);
  });

  it('refuses a wallet that returns the wrong number of transactions or junk', async () => {
    const { fetchImpl, calls } = rpc([]);
    await expect(signSendConfirm(tx, async () => [], undefined, { fetchImpl })).rejects.toThrow('0 signed transactions for 1');
    await expect(signSendConfirm(tx, async () => ['not base64!'], undefined, { fetchImpl })).rejects.toThrow('not a transaction');
    expect(calls).toEqual([]);
  });

  it('reports the program\'s own words when the cluster refuses, and a failed transaction', async () => {
    const refused = rpc([], { message: 'Simulation failed', data: { logs: ['Program log: AnchorError. Error Code: NotInCallWindow. Error Message: Outside the call window.'] } });
    await expect(signSendConfirm(tx, async () => ['BBBB'], undefined, { fetchImpl: refused.fetchImpl, ...fast })).rejects.toThrow('The program refused this: Outside the call window.');
    const failed = rpc([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]);
    await expect(signSendConfirm(tx, async () => ['BBBB'], undefined, { fetchImpl: failed.fetchImpl, ...fast })).rejects.toThrow('failed on chain');
  });

  it('stops waiting after ninety seconds and names the signature', async () => {
    const stuck = rpc(Array.from({ length: 500 }, () => null));
    let t = 0;
    await expect(signSendConfirm(tx, async () => ['BBBB'], undefined, { fetchImpl: stuck.fetchImpl, sleep: async () => undefined, now: () => (t += 10_000) })).rejects.toThrow(/Not confirmed after 90 s.*SIG/);
    expect(ActionError).toBeDefined();
  });
});
