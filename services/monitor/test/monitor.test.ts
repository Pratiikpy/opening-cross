import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner, getAddressEncoder, none } from '@solana/kit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, OrderSide, OrderState, baseVaultAddress, getCrossDecoder, getCrossEncoder, getOrderEncoder, getProtocolEncoder, protocolAddress, quoteVaultAddress } from '@opening-cross/sdk';
import {
  type Check,
  type Finding,
  type Notifier,
  type PauseAction,
  type Rpc,
  Monitor,
  combine,
  consoleNotifier,
  fileNotifier,
  jsonRpc,
  programIntegrity,
  protocolAuthorities,
  stuckCrosses,
  vaultCoversOrders,
  watchedWallets,
  webhookNotifier,
  backingFeedFromApi,
  backingStatus,
  type BackingToken,
} from '../src/index.js';

// ------------------------------------------------------------------------------------------------ a cluster in memory

class FakeRpc implements Rpc {
  accounts = new Map<string, { data: Uint8Array; owner: string; lamports: bigint }>();
  programAccounts: { address: string; data: Uint8Array }[] = [];
  tokens = new Map<string, bigint>();
  signatures = new Map<string, { signature: string; slot: bigint; err: unknown; blockTime: number | null }[]>();
  changes = new Map<string, { mint: string; owner: string; delta: bigint }[] | null>();
  time = 1_800_000_000;
  async getAccount(a: string) {
    return this.accounts.get(a) ?? null;
  }
  async getProgramAccounts(_p: string, filters: { dataSize?: number; memcmp?: { offset: number; bytes: Uint8Array } }[]) {
    return this.programAccounts.filter((a) =>
      filters.every((f) => (f.dataSize !== undefined ? a.data.length === f.dataSize : f.memcmp!.bytes.every((b, i) => a.data[f.memcmp!.offset + i] === b))),
    );
  }
  async getTokenBalance(a: string) {
    return this.tokens.get(a) ?? null;
  }
  async getSignatures(a: string, o: { until?: string; limit: number }) {
    const all = this.signatures.get(a) ?? [];
    const cut = o.until ? all.findIndex((s) => s.signature === o.until) : -1;
    return (cut >= 0 ? all.slice(0, cut) : all).slice(0, o.limit);
  }
  async getTokenChanges(s: string) {
    return this.changes.get(s) ?? null;
  }
  async unixTime() {
    return this.time;
  }
}

const crossBytes = (over: Record<string, unknown>): Uint8Array => {
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  return new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), ...over } as never));
};
const orderBytes = (cross: string, owner: string, side: OrderSide, escrow: bigint): Uint8Array =>
  new Uint8Array(getOrderEncoder().encode({ cross: cross as Address, owner: owner as Address, nonce: 1n, index: 0, side, state: OrderState.Revealed, commitment: new Uint8Array(32), price: 1n, quantity: 1n, escrow, bump: 255 }));
const addr = async () => (await generateKeyPairSigner()).address;

async function liveCross(rpc: FakeRpc, o: { ordersOpen?: number; state?: CrossState; baseBound?: boolean; closeTs?: number; revealEndTs?: number; quote: bigint | null; base?: bigint | null; buyEscrows: bigint[]; sellEscrows?: bigint[] }) {
  const cross = await addr();
  rpc.programAccounts.push({ address: cross, data: crossBytes({ state: o.state ?? CrossState.Live, ordersOpen: o.ordersOpen ?? o.buyEscrows.length + (o.sellEscrows?.length ?? 0), baseBound: o.baseBound ?? true, closeTs: BigInt(o.closeTs ?? rpc.time + 100), revealEndTs: BigInt(o.revealEndTs ?? rpc.time + 100) }) });
  if (o.quote !== null) rpc.tokens.set(await quoteVaultAddress(cross), o.quote);
  if (o.base !== undefined && o.base !== null) rpc.tokens.set(await baseVaultAddress(cross), o.base);
  const owner = await addr();
  for (const e of o.buyEscrows) rpc.programAccounts.push({ address: await addr(), data: orderBytes(cross, owner, OrderSide.Buy, e) });
  for (const e of o.sellEscrows ?? []) rpc.programAccounts.push({ address: await addr(), data: orderBytes(cross, owner, OrderSide.Sell, e) });
  return cross;
}

const ctxOf = (rpc: Rpc, now = 1_800_000_000) => {
  const memo = new Map<string, Promise<unknown>>();
  return { rpc, now, memo: <T>(k: string, fn: () => Promise<T>) => (memo.get(k) as Promise<T> | undefined) ?? (memo.set(k, fn()), memo.get(k) as Promise<T>) };
};

// ------------------------------------------------------------------------------------------------------------ checks

describe('vault-covers-orders', () => {
  it('is silent while every vault holds what its open orders escrowed', async () => {
    const rpc = new FakeRpc();
    await liveCross(rpc, { quote: 1_000n, base: 50n, buyEscrows: [400n, 600n], sellEscrows: [50n] });
    await liveCross(rpc, { quote: 5_000n, base: 0n, buyEscrows: [100n] }); // a vault may hold more than the orders: the bond
    expect(await vaultCoversOrders().run(ctxOf(rpc))).toEqual([]);
  });

  it('reports a shortfall in either vault as critical, with the numbers', async () => {
    const rpc = new FakeRpc();
    const c = await liveCross(rpc, { quote: 999n, base: 49n, buyEscrows: [400n, 600n], sellEscrows: [50n] });
    const f = await vaultCoversOrders().run(ctxOf(rpc));
    expect(f.map((x) => [x.subject, x.severity])).toEqual([[`${c}:quote`, 'critical'], [`${c}:base`, 'critical']]);
    expect(f[0]!.evidence).toMatchObject({ cross: c, vault: 'quote', balance: '999', owed: '1000', shortfall: '1', orders: 3 });
    expect(f[1]!.message).toContain('holds 49, less than the 50');
  });

  it('reports a missing vault that open orders paid into, and ignores crosses that are not Live or have no open orders', async () => {
    const rpc = new FakeRpc();
    const gone = await liveCross(rpc, { quote: null, buyEscrows: [10n] });
    await liveCross(rpc, { quote: 0n, buyEscrows: [], ordersOpen: 0 });
    await liveCross(rpc, { quote: 0n, buyEscrows: [10n], state: CrossState.Cleared });
    const f = await vaultCoversOrders().run(ctxOf(rpc));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ subject: `${gone}:quote`, severity: 'critical' });
    expect(f[0]!.message).toContain('does not exist');
  });

  it('warns, but does not call it critical, when the order counter and the order accounts differ', async () => {
    const rpc = new FakeRpc();
    const c = await liveCross(rpc, { quote: 100n, buyEscrows: [10n], ordersOpen: 3 });
    const f = await vaultCoversOrders().run(ctxOf(rpc));
    expect(f).toEqual([expect.objectContaining({ subject: `${c}:counter`, severity: 'warning' })]);
  });
});

describe('protocol-authorities', () => {
  async function protocol(rpc: FakeRpc, p: { admin: string; guardian: string; feeRecipient: string }) {
    rpc.accounts.set(await protocolAddress(), { owner: CROSS_CORE_PROGRAM_ADDRESS, lamports: 1n, data: new Uint8Array(getProtocolEncoder().encode({ ...p, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() } as never)) });
  }

  it('is silent when the authorities match the pins and do not change', async () => {
    const rpc = new FakeRpc();
    const [admin, guardian, fee] = [await addr(), await addr(), await addr()];
    await protocol(rpc, { admin, guardian, feeRecipient: fee });
    const check = protocolAuthorities({ admin, guardian, feeRecipient: fee });
    expect(await check.run(ctxOf(rpc))).toEqual([]);
    expect(await check.run(ctxOf(rpc))).toEqual([]);
  });

  it('is critical when an authority is not the pinned one, and when one changes between passes', async () => {
    const rpc = new FakeRpc();
    const [admin, guardian, fee, thief] = [await addr(), await addr(), await addr(), await addr()];
    await protocol(rpc, { admin, guardian, feeRecipient: fee });
    const check = protocolAuthorities({ admin: thief });
    const first = await check.run(ctxOf(rpc));
    expect(first).toEqual([expect.objectContaining({ subject: 'pin:admin', severity: 'critical', evidence: { field: 'admin', expected: thief, actual: admin } })]);
    await protocol(rpc, { admin, guardian: thief, feeRecipient: fee });
    const second = await check.run(ctxOf(rpc));
    expect(second.map((f) => f.subject).sort()).toEqual(['change:guardian', 'pin:admin']);
  });

  it('is critical when the protocol account is gone', async () => {
    const f = await protocolAuthorities().run(ctxOf(new FakeRpc()));
    expect(f[0]).toMatchObject({ severity: 'critical', message: expect.stringContaining('missing') });
  });
});

describe('program-integrity', () => {
  const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
  async function deploy(rpc: FakeRpc, program: string, elf: Uint8Array, authority: string | null) {
    const programData = await addr();
    const prog = new Uint8Array(36);
    new DataView(prog.buffer).setUint32(0, 2, true);
    prog.set(getAddressEncoder().encode(programData as Address), 4);
    const pd = new Uint8Array(45 + elf.length + 20); // the loader zero-pads the account
    new DataView(pd.buffer).setUint32(0, 3, true);
    pd[12] = authority ? 1 : 0;
    if (authority) pd.set(getAddressEncoder().encode(authority as Address), 13);
    pd.set(elf, 45);
    rpc.accounts.set(program, { owner: LOADER, lamports: 1n, data: prog });
    rpc.accounts.set(programData, { owner: LOADER, lamports: 1n, data: pd });
  }
  const hash = (b: Uint8Array) => bytesToHex(sha256(b));

  it('matches a pin on the executable bytes with the padding removed and on the upgrade authority', async () => {
    const rpc = new FakeRpc();
    const [prog, auth] = [await addr(), await addr()];
    const elf = Uint8Array.from([1, 2, 3, 4, 5]);
    await deploy(rpc, prog, elf, auth);
    expect(await programIntegrity({ [prog]: { sha256: hash(elf), upgradeAuthority: auth } }).run(ctxOf(rpc))).toEqual([]);
  });

  it('is critical for a changed upgrade authority, a warning (or critical, by option) for changed bytes, and notices an upgrade between passes', async () => {
    const rpc = new FakeRpc();
    const [prog, auth, other] = [await addr(), await addr(), await addr()];
    await deploy(rpc, prog, Uint8Array.from([1, 2, 3]), other);
    const pins = { [prog]: { sha256: hash(Uint8Array.from([9, 9, 9])), upgradeAuthority: auth } };
    const f = await programIntegrity(pins).run(ctxOf(rpc));
    expect(f.map((x) => [x.subject, x.severity])).toEqual([[`${prog}:authority`, 'critical'], [`${prog}:bytes`, 'warning']]);
    expect((await programIntegrity(pins, { executableSeverity: 'critical' }).run(ctxOf(rpc))).find((x) => x.subject.endsWith(':bytes'))!.severity).toBe('critical');
    const check = programIntegrity({ [prog]: {} });
    expect(await check.run(ctxOf(rpc))).toEqual([]);
    await deploy(rpc, prog, Uint8Array.from([4, 5, 6]), other);
    expect((await check.run(ctxOf(rpc)))[0]).toMatchObject({ subject: `${prog}:upgraded`, severity: 'info' });
  });

  it('is critical for something that is not an upgradeable program', async () => {
    const f = await programIntegrity({ [await addr()]: { sha256: 'x' } }).run(ctxOf(new FakeRpc()));
    expect(f[0]).toMatchObject({ severity: 'critical' });
  });
});

describe('stuck-crosses', () => {
  it('warns about a closed cross nobody cleared and about claims left for a day, not about crosses inside their grace', async () => {
    const rpc = new FakeRpc();
    const T = rpc.time;
    const stale = await liveCross(rpc, { quote: 1n, buyEscrows: [1n], closeTs: T - 4_000, revealEndTs: T - 4_000 });
    await liveCross(rpc, { quote: 1n, buyEscrows: [1n], closeTs: T - 100, revealEndTs: T - 100 });
    const claims = await liveCross(rpc, { quote: 1n, buyEscrows: [1n], state: CrossState.Cleared, closeTs: T - 90_000, revealEndTs: T - 90_000 });
    const f = await stuckCrosses().run(ctxOf(rpc, T));
    expect(f.map((x) => [x.subject, x.severity])).toEqual([[`${stale}:clear`, 'warning'], [`${claims}:claims`, 'warning']]);
  });
});

describe('watched-wallets', () => {
  const sig = (s: string, err: unknown = null) => ({ signature: s, slot: 1n, err, blockTime: 1_800_000_000 });
  it('says nothing on the first pass, then reports what the wallet sent, to whom, and ignores what it received', async () => {
    const rpc = new FakeRpc();
    const [team, buyer, mintA, mintB] = [await addr(), await addr(), await addr(), await addr()];
    rpc.signatures.set(team, [sig('old')]);
    const check = watchedWallets([{ address: team, label: 'Team wallet', role: 'team' }]);
    expect(await check.run(ctxOf(rpc))).toEqual([]);
    rpc.signatures.set(team, [sig('new2'), sig('new1'), sig('failed', { InstructionError: 1 }), sig('old')]);
    rpc.changes.set('new1', [{ mint: mintA, owner: team, delta: -500n }, { mint: mintA, owner: buyer, delta: 500n }]);
    rpc.changes.set('new2', [{ mint: mintB, owner: team, delta: 70n }, { mint: mintA, owner: buyer, delta: -3n }]); // the team received; someone else sent
    const f = await check.run(ctxOf(rpc));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'info', message: `Team wallet (team) sent 500 atoms of ${mintA} to ${buyer}`, evidence: { atoms: '500', signature: 'new1', to: buyer } });
    expect(await check.run(ctxOf(rpc))).toEqual([]); // nothing new
  });

  it('applies the mint and size filters, and treats treasury movements as warnings', async () => {
    const rpc = new FakeRpc();
    const [treasury, mintA, mintB] = [await addr(), await addr(), await addr()];
    rpc.signatures.set(treasury, [sig('s0')]);
    const check = watchedWallets([{ address: treasury, label: 'Treasury', role: 'treasury', mints: [mintA], minAtoms: '100' }]);
    await check.run(ctxOf(rpc));
    rpc.signatures.set(treasury, [sig('s3'), sig('s2'), sig('s1'), sig('s0')]);
    rpc.changes.set('s1', [{ mint: mintA, owner: treasury, delta: -99n }]); // under the size
    rpc.changes.set('s2', [{ mint: mintB, owner: treasury, delta: -1_000n }]); // another token
    rpc.changes.set('s3', [{ mint: mintA, owner: treasury, delta: -100n }]);
    const f = await check.run(ctxOf(rpc));
    expect(f).toEqual([expect.objectContaining({ severity: 'warning', evidence: expect.objectContaining({ signature: 's3', atoms: '100' }) })]);
  });
});

// ------------------------------------------------------------------------------------------------------------ engine

class Recorder implements Notifier {
  events: { kind: string; body: Record<string, unknown> }[] = [];
  async notify(e: { kind: 'finding' | 'decision' | 'incident'; at: number; body: unknown }) {
    this.events.push({ kind: e.kind, body: e.body as Record<string, unknown> });
  }
  of(kind: string) {
    return this.events.filter((e) => e.kind === kind);
  }
}

class FakePause implements PauseAction {
  paused = false;
  sent = 0;
  failTimes = 0;
  async isPaused() {
    return this.paused;
  }
  async pause() {
    this.sent++;
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('blockhash expired');
    }
    this.paused = true;
    return { signature: `sig${this.sent}` };
  }
}

/** A check whose output the test controls. */
const scripted = (name = 'scripted'): Check & { out: Finding[]; fail: boolean } => {
  const c = { name, out: [] as Finding[], fail: false, async run() { if (c.fail) throw new Error('rpc down'); return c.out; } };
  return c;
};
const critical = (subject = 'x'): Finding => ({ check: 'scripted', subject, severity: 'critical', message: `${subject} is short`, evidence: {} });
const warning = (subject = 'w'): Finding => ({ check: 'scripted', subject, severity: 'warning', message: `${subject} is odd`, evidence: {} });

describe('the monitor engine', () => {
  const build = (c: Check, o: { pause: PauseAction | null; consecutive?: number }) => {
    const notifier = new Recorder();
    return { notifier, m: new Monitor({ rpc: new FakeRpc(), checks: [c], notifier, pause: o.pause, consecutive: o.consecutive ?? 3, clock: () => 1_800_000_000 }) };
  };

  it('acts only after the same critical finding has persisted for the required passes', async () => {
    const check = scripted();
    const pause = new FakePause();
    const { m, notifier } = build(check, { pause });
    check.out = [critical()];
    expect((await m.pass()).decision).toBeNull();
    expect((await m.pass()).decision).toBeNull();
    expect(pause.sent).toBe(0);
    const third = await m.pass();
    expect(third.decision).toMatchObject({ kind: 'paused', signature: 'sig1' });
    expect(pause.paused).toBe(true);
    expect(notifier.of('incident')[0]!.body).toMatchObject({ event: 'protocol paused by the monitor', signature: 'sig1' });
  });

  it('starts over when the finding goes away: a flapping read never pauses', async () => {
    const check = scripted();
    const pause = new FakePause();
    const { m } = build(check, { pause });
    for (let i = 0; i < 6; i++) {
      check.out = i % 3 === 2 ? [] : [critical()];
      expect((await m.pass()).decision).toBeNull();
    }
    expect(pause.sent).toBe(0);
  });

  it('in dry-run records that it would pause and sends nothing, on every pass the condition lasts', async () => {
    const check = scripted();
    const { m, notifier } = build(check, { pause: null, consecutive: 2 });
    check.out = [critical()];
    await m.pass();
    const a = await m.pass();
    const b = await m.pass();
    expect(a.decision).toMatchObject({ kind: 'would-pause' });
    expect(b.decision).toMatchObject({ kind: 'would-pause' });
    expect(notifier.of('decision')[0]!.body.note).toContain('dry run');
  });

  it('never pauses on warnings or on checks that fail to run, however long they go on', async () => {
    const check = scripted();
    const pause = new FakePause();
    const { m } = build(check, { pause, consecutive: 1 });
    check.out = [warning()];
    for (let i = 0; i < 5; i++) expect((await m.pass()).decision).toBeNull();
    check.out = [];
    check.fail = true;
    for (let i = 0; i < 5; i++) {
      const r = await m.pass();
      expect(r.decision).toBeNull();
      expect(r.checkErrors[0]).toContain('scripted could not run: rpc down');
    }
    expect(pause.sent).toBe(0);
  });

  it('does not send a second transaction when the protocol is already paused, or after it has paused once', async () => {
    const check = scripted();
    const already = new FakePause();
    already.paused = true;
    const a = build(check, { pause: already, consecutive: 1 });
    check.out = [critical()];
    expect((await a.m.pass()).decision).toMatchObject({ kind: 'already-paused' });
    expect(already.sent).toBe(0);

    const pause = new FakePause();
    const b = build(check, { pause, consecutive: 1 });
    expect((await b.m.pass()).decision).toMatchObject({ kind: 'paused' });
    expect((await b.m.pass()).decision).toBeNull();
    expect(pause.sent).toBe(1);
  });

  it('retries a failed pause on the next pass, and says it failed', async () => {
    const check = scripted();
    const pause = new FakePause();
    pause.failTimes = 1;
    const { m, notifier } = build(check, { pause, consecutive: 1 });
    check.out = [critical()];
    expect((await m.pass()).decision).toMatchObject({ kind: 'pause-failed', error: 'blockhash expired' });
    expect(notifier.of('decision')[0]!.body).toMatchObject({ decision: 'pause-failed' });
    expect((await m.pass()).decision).toMatchObject({ kind: 'paused' });
    expect(pause.sent).toBe(2);
  });

  it('does not call it paused unless the chain says so', async () => {
    const check = scripted();
    const pause = new FakePause();
    pause.pause = async () => ({ signature: 'ghost' }); // confirms, but the flag never flips
    const { m } = build(check, { pause, consecutive: 1 });
    check.out = [critical()];
    expect((await m.pass()).decision).toMatchObject({ kind: 'pause-failed', error: expect.stringContaining('not paused') });
  });

  it('announces a warning once until it clears, a critical finding on every pass, and a pause made by someone else', async () => {
    const check = scripted();
    const pause = new FakePause();
    const { m, notifier } = build(check, { pause, consecutive: 99 });
    check.out = [warning(), critical()];
    await m.pass();
    await m.pass();
    expect(notifier.of('finding').filter((e) => (e.body as Finding).severity === 'warning')).toHaveLength(1);
    expect(notifier.of('finding').filter((e) => (e.body as Finding).severity === 'critical')).toHaveLength(2);
    check.out = [];
    await m.pass();
    check.out = [warning()];
    await m.pass();
    expect(notifier.of('finding').filter((e) => (e.body as Finding).severity === 'warning')).toHaveLength(2);
    pause.paused = true;
    await m.pass();
    expect(notifier.of('incident')[0]!.body).toMatchObject({ event: 'protocol paused', by: 'not this monitor' });
  });

  it('rejects a nonsense threshold', () => {
    expect(() => new Monitor({ rpc: new FakeRpc(), checks: [], notifier: new Recorder(), pause: null, consecutive: 0 })).toThrow(/positive integer/);
  });
});

describe('end to end with the real checks', () => {
  it('a vault that stays short for three passes is paused, and a vault that recovers is not', async () => {
    const rpc = new FakeRpc();
    const c = await liveCross(rpc, { quote: 500n, buyEscrows: [400n, 600n] });
    const pause = new FakePause();
    const notifier = new Recorder();
    const m = new Monitor({ rpc, checks: [vaultCoversOrders()], notifier, pause, consecutive: 3, clock: () => rpc.time });
    await m.pass();
    rpc.tokens.set(await quoteVaultAddress(c), 1_000n); // a read that raced a deposit: recovered
    await m.pass();
    expect(pause.sent).toBe(0);
    rpc.tokens.set(await quoteVaultAddress(c), 500n);
    await m.pass();
    await m.pass();
    expect(pause.sent).toBe(0);
    expect((await m.pass()).decision).toMatchObject({ kind: 'paused' });
    expect(pause.sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------- notifiers and rpc

describe('notifiers', () => {
  const event = { kind: 'incident' as const, at: 1_800_000_000, body: { amount: 5n } };
  it('writes JSON lines to the console and a file with bigints as strings', async () => {
    const lines: string[] = [];
    await consoleNotifier((s) => lines.push(s)).notify(event);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: 'incident', at: '2027-01-15T08:00:00.000Z', body: { amount: '5' } });
    const file = join(mkdtempSync(join(tmpdir(), 'mon-')), 'log.jsonl');
    await fileNotifier(file).notify(event);
    await fileNotifier(file).notify(event);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('posts to a webhook, and one destination failing does not stop the others', async () => {
    const posts: unknown[] = [];
    const ok = webhookNotifier('https://hook.test/x', { fetch: (async (_u: string, i: RequestInit) => (posts.push(JSON.parse(String(i.body))), new Response('ok', { status: 200 }))) as unknown as typeof fetch });
    const bad = webhookNotifier('https://hook.test/y', { fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch });
    const errors: unknown[] = [];
    const lines: string[] = [];
    await combine([bad, ok, consoleNotifier((s) => lines.push(s))], (e) => errors.push(e)).notify(event);
    expect(posts).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(String(errors[0])).toContain('HTTP 500');
  });
});

describe('the JSON-RPC reader', () => {
  it('rides out a rate limit, encodes the memcmp filter in base58 and decodes accounts', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const f = (async (_u: string, i: RequestInit) => {
      calls++;
      const req = JSON.parse(String(i.body));
      seen.push(req);
      if (calls === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify({ result: [{ pubkey: 'ACC', account: { data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = jsonRpc('https://rpc.test', { fetch: f, sleep: async () => undefined });
    const out = await rpc.getProgramAccounts('PROG', [{ dataSize: 143 }, { memcmp: { offset: 8, bytes: Uint8Array.from([0, 0, 1]) } }]);
    expect(out).toEqual([{ address: 'ACC', data: Uint8Array.from([1, 2, 3]) }]);
    expect(calls).toBe(2);
    const filters = (seen[1] as { params: [string, { filters: unknown[] }] }).params[1].filters;
    expect(filters).toEqual([{ dataSize: 143 }, { memcmp: { offset: 8, bytes: '112', encoding: 'base58' } }]);
  });

  it('gives up with a clear error when the endpoint stays busy', async () => {
    const rpc = jsonRpc('https://rpc.test', { fetch: (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch, sleep: async () => undefined, attempts: 3 });
    await expect(rpc.getAccount('A')).rejects.toThrow(/busy/);
  });
});

describe('backing-status', () => {
  const tok = (over: Partial<BackingToken> = {}): BackingToken => ({ mint: 'MINT', status: 'verified', reasons: ['covered'], coverageBps: 10_000, ageSecs: 60, custodian: 'Example Custody', liveCross: true, ...over });
  const run = (tokens: BackingToken[]) => backingStatus(async () => tokens).run({ rpc: new FakeRpc(), now: 0, memo: (_k, fn) => fn() });

  it('says nothing about verified tokens, and warns for each kind of unverified one', async () => {
    expect(await run([tok()])).toEqual([]);
    const f = await run([tok({ status: 'stale', reasons: ['The attestation is 200 hours old; the limit is 168 hours.'], mint: 'A' }), tok({ status: 'undercollateralised', coverageBps: 4000, mint: 'B' }), tok({ status: 'unverifiable', coverageBps: null, ageSecs: null, custodian: null, mint: 'C', liveCross: false })]);
    expect(f.map((x) => [x.subject, x.severity])).toEqual([['A', 'warning'], ['B', 'warning'], ['C', 'warning']]);
    expect(f[0]!.message).toMatch(/is stale and has a live cross/);
    expect(f[2]!.message).not.toMatch(/live cross/);
    expect(f[1]!.evidence).toMatchObject({ coverageBps: 4000, status: 'undercollateralised' });
  });

  it('never asks the engine to pause: a warning is not acted on, however many passes', async () => {
    const paused: string[] = [];
    const m = new Monitor({ rpc: new FakeRpc(), consecutive: 1, pause: { async isPaused() { return false; }, async pause() { paused.push('x'); return { signature: 's' }; } }, notifier: { async notify() {} }, checks: [backingStatus(async () => [tok({ status: 'undercollateralised' })])] });
    for (let i = 0; i < 4; i++) await m.pass();
    expect(paused).toEqual([]);
  });

  it('reads the feed from an API and refuses a reply it does not understand', async () => {
    const ok = backingFeedFromApi('https://api.test/', (async (u: string) => new Response(JSON.stringify({ tokens: [tok()] }), { status: u.endsWith('/v1/integrity/backing') ? 200 : 404 })) as never);
    expect(await ok()).toHaveLength(1);
    await expect(backingFeedFromApi('https://api.test', (async () => new Response('x', { status: 503 })) as never)()).rejects.toThrow(/HTTP 503/);
    await expect(backingFeedFromApi('https://api.test', (async () => new Response('{}', { status: 200 })) as never)()).rejects.toThrow(/no tokens list/);
  });
});
