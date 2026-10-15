import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptText, keyFromApiKey } from '../src/aes.js';
import { CleanverseClient } from '../src/client.js';
import {
  BadRequestError,
  BusinessError,
  ConflictError,
  ForbiddenError,
  MalformedResponseError,
  NotFoundHttpError,
  OverrideRequiredError,
  ParameterError,
  ServerError,
  TransportError,
} from '../src/errors.js';
import { STUB_API_ID, STUB_API_KEY, StubCleanverse } from './stub-server.js';

const stub = new StubCleanverse();
let base = '';
const WALLET = '9wF7Yp8MZk2J6qX4R5GQKxE3P7H8YyNQ1JZVfA6mB2c';
const noSleep = async () => {};
const client = (o: Partial<ConstructorParameters<typeof CleanverseClient>[0]> = {}) => new CleanverseClient({ baseUrl: base, apiId: STUB_API_ID, apiKey: STUB_API_KEY, sleep: noSleep, ...o });

beforeAll(async () => {
  base = await stub.start();
});
afterAll(() => stub.stop());
beforeEach(() => {
  stub.passes.clear();
  stub.requests.length = 0;
  stub.failNext = null;
  stub.overrideNext = null;
  stub.delayMs = 0;
  stub.unlisted.clear();
});

const generate = (o: Record<string, unknown> = {}) =>
  client().generateApass({ customerId: 'CUST000000000001', expirationTime: 1863690034, wallet: { address: WALLET, chain: 'solana' }, identityDataList: [{ idType: 'PASSPORT', fullName: 'Test Person', issuingCountryISO2: 'in' }], ...o } as never);

describe('requests', () => {
  it('sends api-id and never the api-key', async () => {
    const seen: Record<string, string>[] = [];
    const c = client({
      fetch: async (url, init) => {
        seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return fetch(url, init);
      },
    });
    await c.queryDepositAtokenList('solana');
    expect(seen[0]!['api-id']).toBe(STUB_API_ID);
    expect(JSON.stringify(seen)).not.toContain(STUB_API_KEY);
    expect(seen[0]!['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('encrypts generate_apass and update_status bodies and leaves reads in plain JSON', async () => {
    const bodies: string[] = [];
    const c = client({
      fetch: async (url, init) => {
        bodies.push(String(init?.body));
        return fetch(url, init);
      },
    });
    await c.generateApass({ customerId: 'CUST000000000001', expirationTime: 1863690034, wallet: { address: WALLET, chain: 'Solana' as never } });
    await c.queryApass('solana', WALLET);
    expect(Object.keys(JSON.parse(bodies[0]!))).toEqual(['data']);
    expect(bodies[0]).not.toContain('CUST0000');
    expect(JSON.parse(bodies[1]!)).toEqual({ chain: 'solana', address: WALLET });
    // The stub decrypted the first body: chain was lower-cased and the optional fields were left out.
    expect(stub.requests[0]!.plaintext).toEqual({ customerId: 'CUST000000000001', expirationTime: 1863690034, wallet: { address: WALLET, chain: 'solana' } });
  });
  it('rejects bad input before any request is made', async () => {
    const c = client();
    await expect(c.queryApass('tron' as never, WALLET)).rejects.toThrow(RangeError);
    await expect(c.queryApass('solana', '')).rejects.toThrow(RangeError);
    await expect(c.queryApass('solana', 'a\nb')).rejects.toThrow(RangeError);
    await expect(generate({ customerId: 'short' })).rejects.toThrow(RangeError);
    await expect(generate({ customerId: 'has-hyphen-in-it-1' })).rejects.toThrow(RangeError);
    await expect(generate({ expirationTime: 0 })).rejects.toThrow(RangeError);
    await expect(generate({ subGroup: 'ABC' })).rejects.toThrow(RangeError);
    await expect(generate({ identityDataList: [{ idType: 'PASSPORT', fullName: 'x', issuingCountryISO2: 'IND' }] })).rejects.toThrow(RangeError);
    await expect(client().queryApassList({ pageSize: 101 })).rejects.toThrow(RangeError);
    await expect(client().faucet({ chain: 'base', symbol: 'usdc', depositAddress: '0x1', amount: '1; drop' })).rejects.toThrow(RangeError);
    expect(stub.requests).toHaveLength(0);
  });
  it('refuses a plain-http base URL outside loopback and a missing api-id', () => {
    expect(() => new CleanverseClient({ baseUrl: 'http://uatapi.cleanverse.com/api/cooperate', apiId: 'x', apiKey: STUB_API_KEY })).toThrow();
    expect(() => new CleanverseClient({ baseUrl: base, apiId: '', apiKey: STUB_API_KEY })).toThrow();
    expect(() => new CleanverseClient({ baseUrl: base, apiId: 'a\nb', apiKey: STUB_API_KEY })).toThrow();
    expect(() => new CleanverseClient({ baseUrl: base, apiId: 'x', apiKey: 'not-base64!' })).toThrow();
  });
});

describe('A-Pass calls', () => {
  it('generates an A-Pass, then reads it back with its country tag derived from the identity document', async () => {
    const r = await generate();
    expect(r.wallet.apassAddress).toMatch(/^PDA/);
    const a = await client().queryApass('solana', WALLET);
    expect(a).toMatchObject({ tier: 3, status: 1, countries: ['IN'], expirationTime: 1863690034 });
  });
  it('answers code 1000 with OverrideRequiredError and succeeds with override', async () => {
    await generate();
    await expect(generate()).rejects.toBeInstanceOf(OverrideRequiredError);
    expect((await generate({ override: true })).wallet.operate).toBe('update');
  });
  it('freezes and unfreezes', async () => {
    await generate();
    await client().updateStatus({ chain: 'solana', address: WALLET, status: 'freeze', blacklistReason: 'sanctions hit' });
    expect((await client().queryApass('solana', WALLET)).status).toBe(2);
    await client().updateStatus({ chain: 'solana', address: WALLET, status: 'activate' });
    expect((await client().queryApass('solana', WALLET)).status).toBe(1);
  });
  it('reports an unknown wallet as a business failure carrying the text, not an empty record', async () => {
    const e = await client().queryApass('solana', WALLET).catch((x) => x);
    expect(e).toBeInstanceOf(BusinessError);
    expect(e).toMatchObject({ code: '0002', subCode: '404' });
  });
  it('lists with filters and paginates', async () => {
    for (let i = 0; i < 5; i++) stub.put({ chain: 'solana', walletAddress: `W${i}`, customerId: `CUSTOMER${String(i).padStart(8, '0')}` });
    stub.put({ chain: 'base', walletAddress: '0xabc' });
    const l = await client().queryApassList({ chain: 'solana', pageSize: 2, page: 3 });
    expect(l).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(l.items).toHaveLength(1);
    const one = await client().queryApassList({ chain: 'solana', walletAddress: 'W2' });
    expect(one.items[0]).toMatchObject({ customerId: 'CUSTOMER00000002', walletAddress: 'W2', status: 1 });
  });
  it('verify_apass returns the documented code', async () => {
    stub.put({ chain: 'solana', walletAddress: WALLET });
    expect((await client().verifyApass('solana', 'ATOKEN', WALLET)).code).toBe(4);
    expect((await client().verifyApass('solana', 'ATOKEN', 'nobody')).code).toBe(2);
  });
  it('faucet and the token list parse', async () => {
    expect((await client().faucet({ chain: 'base', symbol: 'usdc', depositAddress: '0x1', amount: '1' })).txHash).toBe('faucettx');
    expect((await client().queryDepositAtokenList('solana')).tokens[0]!.atoken.symbol).toBe('ausdc');
  });
});

describe('validator reads', () => {
  it('reads registration, rules, pause state and user compliance', async () => {
    stub.registeredPools.set('0xPOOL', [{ allowed_group: 'AB', allowed_sub_group: '', min_tier: 5, min_sub_tier: 0, is_black_list: false, countries: ['us'] }, { allowed_group: '', allowed_sub_group: '', min_tier: 0, min_sub_tier: 0 }]);
    stub.poolValid.set('0xPOOL:0xUSER', true);
    const c = client();
    expect(await c.validatorIsRegistered('base', '0xPOOL')).toBe(true);
    expect(await c.validatorIsRegistered('base', '0xOTHER')).toBe(false);
    expect(await c.validatorRules('base', '0xPOOL')).toEqual([
      { allowedGroup: 'AB', allowedSubGroup: '', minTier: 5, minSubTier: 0, isBlackList: false, countries: ['US'] },
      { allowedGroup: '', allowedSubGroup: '', minTier: 0, minSubTier: 0, isBlackList: false, countries: [] },
    ]);
    expect(await c.validatorVerify('base', '0xPOOL', '0xUSER')).toBe(true);
    expect(await c.validatorVerify('base', '0xPOOL', '0xNOPE')).toBe(false);
    expect(await c.validatorIsPaused('base', '0xPOOL')).toBe(false);
  });
  it('a paused pool answers verify with business code 12027, not a boolean', async () => {
    stub.pausedPools.add('0xPOOL');
    const e = await client().validatorVerify('base', '0xPOOL', '0xU').catch((x) => x);
    expect(e).toBeInstanceOf(BusinessError);
    expect(e.code).toBe('12027');
  });
});

describe('codes and failures', () => {
  const hit = (status: number, body: string) => {
    stub.overrideNext = { status, body };
    return client().queryApass('solana', WALLET).catch((e) => e);
  };
  const env = (code: unknown, message = 'm', data: unknown = '') => JSON.stringify({ code, message, data });
  it('maps HTTP 400, 403, 404, 409 and 500 to distinct errors', async () => {
    expect(await hit(400, 'bad')).toBeInstanceOf(BadRequestError);
    expect(await hit(403, 'Forbidden.Please check your api-id Or contact Cleanverse.')).toBeInstanceOf(ForbiddenError);
    expect(await hit(404, '{}')).toBeInstanceOf(NotFoundHttpError);
    expect(await hit(409, '{}')).toBeInstanceOf(ConflictError);
    stub.overrideNext = { status: 500, body: 'x' };
    expect(await client({ maxAttempts: 1 }).queryApass('solana', WALLET).catch((e) => e)).toBeInstanceOf(ServerError);
    expect(await hit(204, '')).toBeInstanceOf(MalformedResponseError);
  });
  it('maps envelope codes 0001, 0002, 12026 and 12027', async () => {
    expect(await hit(200, env('0001', 'The parameter is incorrect.'))).toBeInstanceOf(ParameterError);
    const b = await hit(200, env('0002', '[RM_007] quote token not found'));
    expect(b).toMatchObject({ code: '0002', subCode: 'RM_007' });
    expect(await hit(200, env('12026', 'write failed'))).toMatchObject({ code: '12026', subCode: '12026' });
    expect(await hit(200, env(12027, 'read failed'))).toMatchObject({ code: '12027' });
  });
  it('an unknown envelope code is an error, not success', async () => {
    expect(await hit(200, env('9999'))).toBeInstanceOf(MalformedResponseError);
    expect(await hit(200, env(''))).toBeInstanceOf(MalformedResponseError);
    expect(await hit(200, JSON.stringify({ message: 'no code' }))).toBeInstanceOf(MalformedResponseError);
  });
  const good = { cvRecordId: '1', subTier: 1, status: 1, tier: '3', expirationTime: 1863690034, subGroup: '', currentKycHash: 'ab', group: '', countries: ['IN'] };
  it('rejects every malformed success body', async () => {
    const bad: [string, unknown][] = [
      ['not JSON', undefined],
      ['array body', []],
      ['null data', null],
      ['string data', 'hello'],
      ['missing tier', { ...good, tier: undefined }],
      ['numeric-looking but non-numeric tier', { ...good, tier: 'gold' }],
      ['tier number type', { ...good, tier: 3.5 }],
      ['status 3', { ...good, status: 3 }],
      ['status as text', { ...good, status: 'active' }],
      ['negative expiry', { ...good, expirationTime: -1 }],
      ['fractional expiry', { ...good, expirationTime: 1.5 }],
      ['expiry as ISO date', { ...good, expirationTime: '2029-01-21' }],
      ['countries not an array', { ...good, countries: 'IN' }],
      ['alpha-3 country', { ...good, countries: ['IND'] }],
      ['numeric country', { ...good, countries: [356] }],
      ['missing cvRecordId', { ...good, cvRecordId: undefined }],
    ];
    for (const [name, data] of bad) {
      const raw = name === 'not JSON' ? 'oops' : name === 'array body' ? '[]' : env('0000', 'success', data);
      expect(await hit(200, raw), name).toBeInstanceOf(MalformedResponseError);
    }
    expect(await hit(200, env('0000', 'success', good))).toMatchObject({ tier: 3, status: 1, countries: ['IN'] });
  });
  it('accepts the documented absences: no country field reads as no tags, upper-cases and de-duplicates tags', async () => {
    const { countries: _c, ...noCountries } = good;
    expect(await hit(200, env('0000', 'success', noCountries))).toMatchObject({ countries: [] });
    expect(await hit(200, env('0000', 'success', { ...good, countries: ['sg', 'SG', 'us'] }))).toMatchObject({ countries: ['SG', 'US'] });
  });
  it('accepts data sent as a JSON string, as the reference shows for empty results', async () => {
    expect(await hit(200, env('0000', 'success', JSON.stringify(good)))).toMatchObject({ tier: 3 });
  });
  it('refuses a list that claims more than 100 rows and a response that is too large', async () => {
    stub.overrideNext = { status: 200, body: env('0000', 'ok', { total: 101, page: 1, pageSize: 100, items: Array.from({ length: 101 }, () => ({})) }) };
    await expect(client().queryApassList()).rejects.toBeInstanceOf(MalformedResponseError);
    expect(await hit(200, ' '.repeat(1_100_000))).toBeInstanceOf(MalformedResponseError);
  });
  it('decrypts an encrypted response to an encrypted request', async () => {
    const key = keyFromApiKey(STUB_API_KEY);
    const inner = JSON.stringify({ code: '0000', message: 'success', data: { customerId: 'CUST000000000001', cvRecordId: '9', tier: '3', wallet: { operate: 'create', address: WALLET, chain: 'solana', txHash: 'tx', apassAddress: 'PDA' } } });
    for (const wrapped of [encryptText(inner, key), JSON.stringify({ data: encryptText(inner, key) })]) {
      stub.overrideNext = { status: 200, body: wrapped };
      expect((await generate()).cvRecordId).toBe('9');
    }
    stub.overrideNext = { status: 200, body: 'garbage that is not ciphertext' };
    await expect(generate()).rejects.toBeInstanceOf(MalformedResponseError);
  });
});

describe('retries', () => {
  it('retries a read through two 500s with growing backoff and then succeeds', async () => {
    stub.put({ chain: 'solana', walletAddress: WALLET });
    stub.failNext = { count: 2, status: 500 };
    const waits: number[] = [];
    const a = await client({ sleep: async (ms) => void waits.push(ms) }).queryApass('solana', WALLET);
    expect(a.status).toBe(1);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });
  it('gives up after the attempt limit and reports the server error', async () => {
    stub.failNext = { count: 10, status: 503 };
    await expect(client({ maxAttempts: 3 }).queryApass('solana', WALLET)).rejects.toBeInstanceOf(ServerError);
    expect(stub.failNext.count).toBe(7);
  });
  it('does not retry 4xx or business failures', async () => {
    stub.failNext = { count: 5, status: 403 };
    await expect(client().queryApass('solana', WALLET)).rejects.toBeInstanceOf(ForbiddenError);
    expect(stub.failNext.count).toBe(4);
    stub.failNext = null;
    await expect(client({ apiId: 'wrong-id' }).queryApass('solana', WALLET)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('does not repeat a write after a 500 unless asked to', async () => {
    stub.failNext = { count: 1, status: 500 };
    await expect(generate()).rejects.toBeInstanceOf(ServerError);
    expect(stub.passes.size).toBe(0);
    stub.failNext = { count: 1, status: 500 };
    const r = await client({ retryWrites: true }).generateApass({ customerId: 'CUST000000000001', expirationTime: 1863690034, wallet: { address: WALLET, chain: 'solana' } });
    expect(r.customerId).toBe('CUST000000000001');
  });
  it('times out a slow response and reports a transport error', async () => {
    stub.delayMs = 300;
    await expect(client({ timeoutMs: 40, maxAttempts: 2 }).queryApass('solana', WALLET)).rejects.toBeInstanceOf(TransportError);
    stub.delayMs = 0;
  });
  it('reports a refused connection as a transport error', async () => {
    await expect(client({ baseUrl: 'http://127.0.0.1:9/api/cooperate', maxAttempts: 2 }).queryApass('solana', WALLET)).rejects.toBeInstanceOf(TransportError);
  });
});
