// The attester: configuration that refuses what could make it state something untrue, the readers of each source, the decision of when to post, and whole passes against an in-memory chain
// (the statement it posts is the exact instruction cross_backing's `attest` takes, signed by the policy's attester and nobody else).
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import { ATTEST_DISCRIMINATOR, getAttestInstructionDataDecoder, getAttestationEncoder, getPolicyEncoder } from '@opening-cross/cross-backing-client';
import { CROSS_BACKING_PROGRAM_ADDRESS, backingAddresses } from '@opening-cross/sdk';
import { ConfigError, SourceError, attestOnce, headersOf, integer, parseConfig, planAttestation, readBacking, scaled, timestamp } from '../src/index.js';

const NOW = 1_800_000_000n;
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const key = async () => (await generateKeyPairSigner()).address;

describe('configuration', () => {
  const asset = (source: unknown, mint = '11111111111111111111111111111112') => ({ mint, source });
  const ok = { assets: [asset({ type: 'file-json', path: '/tmp/r.json', valuePath: 'backing', asOfPath: 'asOf' })] };

  it('fills the defaults and keeps the rest', () => {
    const c = parseConfig(ok);
    expect(c).toMatchObject({ refreshFraction: 0.5, minChangeBps: 50, minIntervalSecs: 60, maxIncreaseFactor: 4 });
    expect(c.assets[0]!.source).toMatchObject({ type: 'file-json', maxStalenessSecs: 3_600, scale: { mul: 1n, div: 1n } });
  });

  it('refuses what would make it state something untrue or sign for the wrong thing', () => {
    const bad = (c: unknown, message: RegExp) => expect(() => parseConfig(c), JSON.stringify(c)).toThrow(message);
    bad({}, /name at least one asset/);
    bad({ assets: [] }, /name at least one asset/);
    bad({ ...ok, extra: 1 }, /unknown field extra/);
    bad({ assets: [asset({ type: 'oracle' })] }, /must be "token-accounts", "http-json" or "file-json"/);
    bad({ assets: [asset({ type: 'file-json', path: '/x', valuePath: 'a' }, 'not-an-address')] }, /mint: must be a base58/);
    bad({ assets: [asset({ type: 'file-json', path: '/x', valuePath: 'a' }), asset({ type: 'file-json', path: '/y', valuePath: 'a' })] }, /configured twice/);
    bad({ assets: [asset({ type: 'http-json', url: 'http://custodian.example/r', valuePath: 'a' })] }, /must be https/);
    bad({ assets: [asset({ type: 'http-json', url: 'nonsense', valuePath: 'a' })] }, /is not a URL/);
    bad({ assets: [asset({ type: 'token-accounts', accounts: [] })] }, /at least one token account/);
    bad({ assets: [asset({ type: 'file-json', path: '/x', valuePath: 'a', scale: { mul: '0' } })] }, /positive integer/);
    bad({ assets: [asset({ type: 'file-json', path: '/x', valuePath: 'a', maxStalenessSecs: 0 })] }, /from 1 to/);
    bad({ ...ok, refreshFraction: 1 }, /from 0.05 to 0.95/);
    expect(() => parseConfig('x')).toThrow(ConfigError);
    expect(parseConfig({ assets: [asset({ type: 'http-json', url: 'http://127.0.0.1:9/r', valuePath: 'a', allowInsecure: true })] }).assets).toHaveLength(1);
  });
});

describe('reading a figure', () => {
  it('takes whole atoms only: a decimal string or a safe integer; never a fraction, a float, a negative or an unsafe number', () => {
    expect(integer('123456789012345678901', 'x')).toBe(123456789012345678901n);
    expect(integer(42, 'x')).toBe(42n);
    expect(integer(0, 'x')).toBe(0n);
    for (const [v, code] of [[1.5, 'NOT_AN_INTEGER'], ['1.5', 'NOT_AN_INTEGER'], ['1e6', 'NOT_AN_INTEGER'], [-1, 'NEGATIVE'], ['-5', 'NEGATIVE'], [2 ** 60, 'NOT_AN_INTEGER'], [null, 'NOT_AN_INTEGER'], [{}, 'NOT_AN_INTEGER'], ['', 'NOT_AN_INTEGER'], [NaN, 'NOT_AN_INTEGER'], [Infinity, 'NOT_AN_INTEGER']] as [unknown, string][]) {
      expect(() => integer(v, 'x'), String(v)).toThrow(SourceError);
      try {
        integer(v, 'x');
      } catch (e) {
        expect((e as SourceError).code, String(v)).toBe(code);
      }
    }
  });

  it('scales in integers, rounding down, and refuses a figure that does not fit 64 bits', () => {
    expect(scaled(12_345n, { mul: 1n, div: 100n })).toBe(123n);
    expect(scaled(7n, { mul: 1_000_000n, div: 1n })).toBe(7_000_000n);
    expect(scaled((1n << 64n) - 1n, { mul: 1n, div: 1n })).toBe((1n << 64n) - 1n);
    expect(() => scaled(1n << 64n, { mul: 1n, div: 1n })).toThrow(/64-bit/);
  });

  it('reads a time as seconds, milliseconds or ISO 8601', () => {
    expect(timestamp(1_800_000_000, 't')).toBe(1_800_000_000n);
    expect(timestamp(1_800_000_000_123, 't')).toBe(1_800_000_000n);
    expect(timestamp('2027-01-15T08:00:00Z', 't')).toBe(BigInt(Date.parse('2027-01-15T08:00:00Z') / 1000));
    expect(timestamp('1800000000', 't')).toBe(1_800_000_000n);
    expect(() => timestamp('yesterday', 't')).toThrow(/not a time/);
    expect(() => timestamp(0, 't')).toThrow(/not a time/);
  });

  it('resolves a header from the environment and refuses one that is not set', () => {
    expect(headersOf({ authorization: 'env:TOKEN', 'x-plain': 'v' }, { TOKEN: 'abc' })).toEqual({ authorization: 'abc', 'x-plain': 'v' });
    expect(() => headersOf({ authorization: 'env:TOKEN' }, {})).toThrow(/TOKEN, which is not set/);
  });
});

describe('the sources', () => {
  const noAccount = async () => null;
  const response = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const http = (o: Record<string, unknown> = {}) => parseConfig({ assets: [{ mint: '11111111111111111111111111111112', source: { type: 'http-json', url: 'https://c.example/r', valuePath: 'reserves.total', asOfPath: 'asOf', ...o } }] }).assets[0]!.source;
  const read = (source: ReturnType<typeof http>, fetchImpl: typeof fetch, extra: object = {}) => readBacking(source, { now: () => NOW, account: noAccount, fetch: fetchImpl, env: {}, ...extra });
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as SourceError).code);

  it('reads an http figure with its time and applies the scale', async () => {
    const r = await read(http({ scale: { mul: '1', div: '100' } }), response({ reserves: { total: '123456' }, asOf: Number(NOW) - 60 }) as never);
    expect(r).toMatchObject({ atoms: 1_234n, asOf: NOW - 60n });
  });

  it('refuses a figure it cannot trust: stale, undated, from the future, fractional, negative, missing, unreachable, not JSON, a bad status', async () => {
    expect(await code(read(http(), response({ reserves: { total: '5' }, asOf: Number(NOW) - 3_601 }) as never))).toBe('STALE_SOURCE');
    expect(await code(read(http(), response({ reserves: { total: '5' }, asOf: Number(NOW) - 3_600 }) as never))).toBe('ok');
    expect(await code(read(http(), response({ reserves: { total: '5' }, asOf: Number(NOW) + 3_600 }) as never))).toBe('BAD_RESPONSE');
    expect(await code(read(http({ asOfPath: undefined }), response({ reserves: { total: '5' } }) as never))).toBe('MISSING_FIELD');
    expect(await code(read(http(), response({ reserves: { total: 5.5 }, asOf: Number(NOW) }) as never))).toBe('NOT_AN_INTEGER');
    expect(await code(read(http(), response({ reserves: { total: -5 }, asOf: Number(NOW) }) as never))).toBe('NEGATIVE');
    expect(await code(read(http(), response({ reserves: {}, asOf: Number(NOW) }) as never))).toBe('MISSING_FIELD');
    expect(await code(read(http(), response('<html>', 200) as never))).toBe('BAD_RESPONSE');
    expect(await code(read(http(), response({}, 503) as never))).toBe('BAD_RESPONSE');
    expect(await code(read(http(), (async () => { throw new Error('ECONNREFUSED'); }) as never))).toBe('UNREACHABLE');
    expect(await code(read(http({ headers: { authorization: 'env:NOPE' } }), response({}) as never))).toBe('UNREACHABLE');
    expect(await code(read(http(), response('x'.repeat(1_000_001)) as never))).toBe('BAD_RESPONSE');
  });

  it('reads a report file the same way, and a missing or broken file is a failure, not a zero', async () => {
    const file = parseConfig({ assets: [{ mint: '11111111111111111111111111111112', source: { type: 'file-json', path: '/r.json', valuePath: 'backing', asOfPath: 'asOf' } }] }).assets[0]!.source;
    const ok = await readBacking(file, { now: () => NOW, account: noAccount, readFile: async () => JSON.stringify({ backing: '900', asOf: String(NOW) }) });
    expect(ok.atoms).toBe(900n);
    expect(await code(readBacking(file, { now: () => NOW, account: noAccount, readFile: async () => { throw new Error('ENOENT'); } }))).toBe('UNREACHABLE');
    expect(await code(readBacking(file, { now: () => NOW, account: noAccount, readFile: async () => '{' }))).toBe('UNREACHABLE');
    expect(await code(readBacking(file, { now: () => NOW, account: noAccount, readFile: async () => JSON.stringify({ backing: '1', asOf: 1_000 }) }))).toBe('STALE_SOURCE');
  });

  it('sums the reserve accounts it is pointed at and refuses a missing one, one that is not a token account, or one holding another token', async () => {
    const [mint, other, a, b, c] = await Promise.all([key(), key(), key(), key(), key()]);
    const tokenData = (m: Address, amount: bigint) => {
      const d = new Uint8Array(165);
      d.set(getAddressEncoder().encode(m) as Uint8Array, 0);
      new DataView(d.buffer).setBigUint64(64, amount, true);
      return d;
    };
    const accounts = new Map<string, { data: Uint8Array; owner: Address }>([[a, { data: tokenData(mint, 700n), owner: SPL }], [b, { data: tokenData(mint, 300n), owner: SPL }], [c, { data: tokenData(other, 5n), owner: SPL }]]);
    const account = async (x: Address) => accounts.get(x) ?? null;
    const src = (list: Address[], m: Address | undefined = mint) => parseConfig({ assets: [{ mint, source: { type: 'token-accounts', accounts: list, ...(m ? { mint: m } : {}) } }] }).assets[0]!.source;
    expect((await readBacking(src([a, b]), { now: () => NOW, account })).atoms).toBe(1_000n);
    expect(await code(readBacking(src([a, await key()]), { now: () => NOW, account }))).toBe('MISSING_ACCOUNT');
    expect(await code(readBacking(src([a, c]), { now: () => NOW, account }))).toBe('WRONG_MINT');
    accounts.set(a, { data: new Uint8Array(10), owner: SPL });
    expect(await code(readBacking(src([a]), { now: () => NOW, account }))).toBe('MISSING_ACCOUNT');
  });
});

describe('planAttestation', () => {
  const cfg = { refreshFraction: 0.5, minChangeBps: 50, minIntervalSecs: 60, maxIncreaseFactor: 4 };
  const me = '11111111111111111111111111111112' as Address;
  const f = (o: Partial<{ last: { backingAtoms: bigint; postedTs: bigint } | null; observed: bigint; now: bigint; attester: Address }> = {}) => ({
    signer: me,
    policy: { attester: o.attester ?? me, maxAgeSecs: 3_600n },
    last: o.last === undefined ? { backingAtoms: 1_000n, postedTs: NOW - 1_000n } : o.last,
    observed: o.observed ?? 1_000n,
    now: o.now ?? NOW,
  });

  it('posts the first statement, then refreshes at half the maximum age, sooner on a real change, and otherwise waits', () => {
    expect(planAttestation(f({ last: null }), cfg)).toEqual({ post: true, reason: 'FIRST_STATEMENT' });
    expect(planAttestation(f(), cfg)).toEqual({ post: false, reason: 'FRESH_ENOUGH' });
    expect(planAttestation(f({ last: { backingAtoms: 1_000n, postedTs: NOW - 1_800n } }), cfg)).toEqual({ post: true, reason: 'REFRESH' });
    expect(planAttestation(f({ last: { backingAtoms: 1_000n, postedTs: NOW - 1_799n } }), cfg)).toEqual({ post: false, reason: 'FRESH_ENOUGH' });
    expect(planAttestation(f({ observed: 1_005n }), cfg)).toEqual({ post: true, reason: 'CHANGED' }); // 0.5%
    expect(planAttestation(f({ observed: 1_004n }), cfg)).toEqual({ post: false, reason: 'FRESH_ENOUGH' });
    expect(planAttestation(f({ observed: 995n }), cfg)).toEqual({ post: true, reason: 'CHANGED' });
  });

  it('tells the truth when the reserve falls, however far; but holds back a figure far above the last one', () => {
    expect(planAttestation(f({ observed: 0n }), cfg)).toEqual({ post: true, reason: 'CHANGED' });
    expect(planAttestation(f({ observed: 4_000n }), cfg)).toEqual({ post: true, reason: 'CHANGED' });
    expect(planAttestation(f({ observed: 4_001n }), cfg)).toEqual({ post: false, reason: 'JUMP_TOO_LARGE' });
    expect(planAttestation(f({ observed: 4_001n }), { ...cfg, maxIncreaseFactor: 0 })).toEqual({ post: true, reason: 'CHANGED' });
    // from nothing, any figure is a change, and the guard has nothing to compare with
    expect(planAttestation(f({ last: { backingAtoms: 0n, postedTs: NOW - 100n }, observed: 5n }), cfg)).toEqual({ post: true, reason: 'CHANGED' });
  });

  it('does not post twice in a minute, replaces a statement dated in the future at once, and never signs another attester\'s policy', () => {
    expect(planAttestation(f({ last: { backingAtoms: 1_000n, postedTs: NOW - 59n }, observed: 2_000n }), cfg)).toEqual({ post: false, reason: 'TOO_SOON' });
    expect(planAttestation(f({ last: { backingAtoms: 1_000n, postedTs: NOW + 500n } }), cfg)).toEqual({ post: true, reason: 'REFRESH' });
    expect(planAttestation(f({ attester: '11111111111111111111111111111113' as Address }), cfg)).toEqual({ post: false, reason: 'NOT_OUR_POLICY' });
  });
});

describe('a pass', () => {
  async function world(o: { last?: { backingAtoms: bigint; postedTs: bigint } | null; attesterIsUs?: boolean; policy?: boolean; supply?: bigint; source?: { backing: string; asOf: number } | 'down' } = {}) {
    const signer = await generateKeyPairSigner();
    const mint = await key();
    const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
    const a = await backingAddresses(mint);
    if (o.policy !== false) accounts.set(a.policy, { owner: CROSS_BACKING_PROGRAM_ADDRESS, data: new Uint8Array(getPolicyEncoder().encode({ mint, attester: o.attesterIsUs === false ? await key() : signer.address, minCoverageBps: 10_000, maxAgeSecs: 3_600n, bump: 255 })) });
    const l = o.last === undefined ? null : o.last;
    if (l) accounts.set(a.attestation, { owner: CROSS_BACKING_PROGRAM_ADDRESS, data: new Uint8Array(getAttestationEncoder().encode({ mint, backingAtoms: l.backingAtoms, postedTs: l.postedTs, bump: 255 })) });
    const mintData = new Uint8Array(82);
    new DataView(mintData.buffer).setBigUint64(36, o.supply ?? 1_000n, true);
    accounts.set(mint, { owner: SPL, data: mintData });
    const sent: Instruction[][] = [];
    const config = parseConfig({ assets: [{ mint, source: { type: 'file-json', path: '/r', valuePath: 'backing', asOfPath: 'asOf' } }] });
    const deps = {
      signer,
      config,
      account: async (x: Address) => accounts.get(x) ?? null,
      now: () => NOW,
      readFile: async () => {
        if (o.source === 'down') throw new Error('ENOENT');
        return JSON.stringify(o.source ?? { backing: '1000', asOf: Number(NOW) - 30 });
      },
      send: async (ixs: Instruction[]) => (sent.push(ixs), `sig${sent.length}`),
    };
    return { signer, mint, a, sent, deps };
  }

  it('posts the figure the source gave, signed by the policy\'s attester, and says whether it covers the supply', async () => {
    const w = await world();
    const [out] = await attestOnce(w.deps);
    expect(out).toMatchObject({ status: 'posted', reason: 'FIRST_STATEMENT', backingAtoms: 1_000n, verdictAfter: 'Backed' });
    expect(w.sent).toHaveLength(1);
    const ix = w.sent[0]![0]!;
    expect(ix.programAddress).toBe(CROSS_BACKING_PROGRAM_ADDRESS);
    expect(Array.from(ix.data!.slice(0, 8))).toEqual(Array.from(ATTEST_DISCRIMINATOR));
    expect(getAttestInstructionDataDecoder().decode(ix.data!).backingAtoms).toBe(1_000n);
    expect(ix.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([w.signer.address, w.a.policy, w.a.attestation]));
  });

  it('posts a figure that does not cover the supply as it is, and says so: the attester states the truth and the watchdog acts on it', async () => {
    const w = await world({ supply: 2_000n });
    const [out] = await attestOnce(w.deps);
    expect(out).toMatchObject({ status: 'posted', verdictAfter: 'Short', backingAtoms: 1_000n });
  });

  it('posts nothing when the source fails or is stale, and reports why: the statement is left to age out', async () => {
    const down = await world({ source: 'down', last: { backingAtoms: 1_000n, postedTs: NOW - 1_900n } });
    const [out] = await attestOnce(down.deps);
    expect(out).toMatchObject({ status: 'failed', code: 'UNREACHABLE' });
    expect((out as { message: string }).message).toMatch(/ages out and the asset halts/);
    expect(down.sent).toEqual([]);
    const stale = await world({ source: { backing: '1000', asOf: Number(NOW) - 7_200 }, last: { backingAtoms: 1_000n, postedTs: NOW - 1_900n } });
    expect((await attestOnce(stale.deps))[0]).toMatchObject({ status: 'failed', code: 'STALE_SOURCE' });
    expect(stale.sent).toEqual([]);
  });

  it('waits while the last statement is fresh, and posts again once it is half the maximum age', async () => {
    const fresh = await world({ last: { backingAtoms: 1_000n, postedTs: NOW - 600n } });
    expect((await attestOnce(fresh.deps))[0]).toMatchObject({ status: 'skipped', code: 'FRESH_ENOUGH' });
    expect(fresh.sent).toEqual([]);
    const old = await world({ last: { backingAtoms: 1_000n, postedTs: NOW - 1_800n } });
    expect((await attestOnce(old.deps))[0]).toMatchObject({ status: 'posted', reason: 'REFRESH' });
  });

  it('holds back an overstated figure, refuses a policy that names another attester, and skips an asset with no policy', async () => {
    const jump = await world({ source: { backing: '9000', asOf: Number(NOW) - 30 }, last: { backingAtoms: 1_000n, postedTs: NOW - 1_900n } });
    expect((await attestOnce(jump.deps))[0]).toMatchObject({ status: 'failed', code: 'JUMP_TOO_LARGE' });
    expect(jump.sent).toEqual([]);
    const notUs = await world({ attesterIsUs: false });
    expect((await attestOnce(notUs.deps))[0]).toMatchObject({ status: 'failed', code: 'NOT_OUR_POLICY' });
    expect(notUs.sent).toEqual([]);
    const none = await world({ policy: false });
    expect((await attestOnce(none.deps))[0]).toMatchObject({ status: 'skipped', code: 'NO_POLICY' });
  });

  it('plans a dry run and sends nothing; reports a send the program refuses and carries on', async () => {
    const dry = await world();
    expect((await attestOnce({ ...dry.deps, dryRun: true }))[0]).toMatchObject({ status: 'planned', reason: 'FIRST_STATEMENT', backingAtoms: 1_000n });
    expect(dry.sent).toEqual([]);
    const refused = await world();
    expect((await attestOnce({ ...refused.deps, send: async () => { throw new Error('Error Code: Unauthorized\nsecond line'); } }))[0]).toMatchObject({ status: 'failed', code: 'SEND_FAILED', message: 'Error Code: Unauthorized' });
  });

  it('is idempotent: after the statement lands, the next pass finds it fresh and posts nothing', async () => {
    const w = await world();
    const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
    const base = w.deps.account;
    const posted = new Map<string, { backingAtoms: bigint; postedTs: bigint }>();
    const deps = {
      ...w.deps,
      account: async (x: Address) => {
        if (x === w.a.attestation && posted.has('p')) return { owner: CROSS_BACKING_PROGRAM_ADDRESS, data: new Uint8Array(getAttestationEncoder().encode({ mint: w.mint, ...posted.get('p')!, bump: 255 })) };
        return accounts.get(x) ?? base(x);
      },
      send: async (ixs: Instruction[]) => {
        posted.set('p', { backingAtoms: getAttestInstructionDataDecoder().decode(ixs[0]!.data!).backingAtoms, postedTs: NOW });
        w.sent.push(ixs);
        return 'sig';
      },
    };
    expect((await attestOnce(deps))[0]!.status).toBe('posted');
    expect((await attestOnce(deps))[0]).toMatchObject({ status: 'skipped', code: 'TOO_SOON' });
    expect(w.sent).toHaveLength(1);
  });
});
