import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { CREATE_SCHEMA } from '../src/create-file.js';
import { COMMANDS } from '../src/main.js';
import { VERSION } from '../src/version.js';
import { CROSS_ADDRESS, cli, crossBytes, fakeRpc, key } from './support.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'oc-cli-'));
const NOW = 1_800_000_000;

describe('help and usage', () => {
  it('lists every command with its summary and documents the exit codes', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    for (const c of COMMANDS) expect(r.stdout, c.path.join(' ')).toContain(c.path.join(' '));
    expect(r.stdout).toMatch(/Exit codes:[\s\S]*\n {2}0 {2}success[\s\S]*\n {2}2 {2}bad command/);
    expect((await cli([])).stdout).toBe(r.stdout);
    expect((await cli(['help'])).stdout).toBe(r.stdout);
  });

  it('shows one command’s options, including the signing ones only where it signs', async () => {
    const place = await cli(['order', 'place', '--help']);
    expect(place.code).toBe(0);
    expect(place.stdout).toContain('--keypair');
    expect(place.stdout).toContain('--dry-run');
    const get = await cli(['cross', 'get', '--help']);
    expect(get.stdout).not.toContain('--keypair');
    expect((await cli(['help', 'order', 'place'])).stdout).toBe(place.stdout);
  });

  it('prints its version, equal to package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect((await cli(['--version'])).stdout).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it('refuses an unknown command, an unknown flag and a missing argument with exit 2 and sends nothing', async () => {
    for (const argv of [['frobnicate'], ['cross'], ['order'], ['cross', 'get'], ['cross', 'get', CROSS_ADDRESS, '--bogus'], ['order', 'place', CROSS_ADDRESS, 'extra', 'args', '--side', 'buy']]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^error: /);
      expect(r.stdout).toBe('');
    }
  });

  it('has no key generation command and says why', async () => {
    for (const w of ['keygen', 'wallet', 'new-keypair']) {
      const r = await cli([w]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('never generates or stores keys');
    }
    expect(COMMANDS.map((c) => c.path.join(' ')).join(' ')).not.toMatch(/keygen|wallet/);
  });

  it('answers errors as JSON on stderr, with the exit code inside, when asked for JSON', async () => {
    const r = await cli(['cross', 'get', 'nope', '--json']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('base58'), exit: 2 } });
  });
});

describe('careless callers', () => {
  const A = CROSS_ADDRESS;

  it('rejects bad addresses, numbers, sides, clusters and URLs before touching the network', async () => {
    const cases: [string[], RegExp][] = [
      [['cross', 'get', 'not-an-address'], /base58/],
      [['cross', 'get', `${A}0`], /base58/],
      [['order', 'cancel', A, '--nonce=-1', '--keypair', 'x'], /whole number/],
      [['order', 'cancel', A, '--nonce', '18446744073709551616', '--keypair', 'x'], /whole number/],
      [['order', 'place', A, '--side', 'hold', '--price', '1', '--quantity', '1'], /--side must be/],
      [['cross', 'get', A, '--cluster', 'mars'], /--cluster must be one of/],
      [['cross', 'get', A, '--rpc', 'ftp://x'], /--rpc must be an http/],
      [['cross', 'list', '--state', 'Maybe', '--api', 'http://x'], /--state must be one of/],
      [['cross', 'list', '--limit', '0', '--api', 'http://x'], /--limit must be from 1 to 200/],
      [['cross', 'list'], /--api/],
      [['order', 'cancel', A, '--nonce', '1', '--build', 'cloud'], /--build must be/],
      [['watch', A, '--count', '0'], /--count must be a whole number of at least 1/],
    ];
    for (const [argv, re] of cases) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toMatch(re);
    }
  });

  it('asks for a key when a command signs and none was given, and never invents one', async () => {
    const r = await cli(['order', 'cancel', A, '--nonce', '1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--keypair');
    expect(r.stderr).toContain('never creates or stores keys');
  });

  it('names a missing key file and refuses junk without echoing its contents', async () => {
    const dir = tmp();
    const missing = await cli(['order', 'cancel', A, '--nonce', '1', '--keypair', join(dir, 'nope.json')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('No keypair file at');

    const secretLooking = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256));
    const cases: [string, string][] = [
      ['not json {', 'not valid JSON'],
      ['[1,2,3]', 'expected a JSON array of 64 bytes'],
      [JSON.stringify(Array.from({ length: 64 }, () => 300)), 'expected a JSON array of 64 bytes'],
      [secretLooking, 'does not hold a valid keypair'],
      ['{"secretKey":"abc"}', 'expected a JSON array of 64 bytes'],
    ];
    for (const [body, message] of cases) {
      const file = join(dir, 'k.json');
      writeFileSync(file, body);
      const r = await cli(['order', 'cancel', A, '--nonce', '1', '--keypair', file]);
      expect(r.code, body).toBe(2);
      expect(r.stderr, body).toContain(message);
      // Nothing from the file may appear in the output, in any form.
      expect(r.stderr + r.stdout).not.toContain(body.slice(0, 20));
      expect(r.stderr + r.stdout).not.toContain('13,20,27');
    }
    const env = await cli(['order', 'cancel', A, '--nonce', '1'], { env: { OPENING_CROSS_SECRET_KEY: secretLooking } });
    expect(env.code).toBe(2);
    expect(env.stderr).toContain('OPENING_CROSS_SECRET_KEY does not hold a valid keypair');
    expect(env.stderr).not.toContain('13,20,27');
  });

  it('turns an unreachable endpoint into exit 3 and says nothing was sent', async () => {
    const r = await cli(['cross', 'get', A, '--rpc', 'http://127.0.0.1:1']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('could not be reached');
  });
});

describe('create file', () => {
  const file = (body: unknown) => {
    const p = join(tmp(), 'cross.json');
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };
  const base = { quoteMint: key('q'), baseMint: key('b'), supplyMode: 'escrow', disclosure: 'open', grid: { min: '1', tick: '0.05', ticks: 10 }, window: { close: '+10m' }, shards: 2, maxOrders: 100 };

  it('needs --file, and reports unreadable and junk files as usage errors', async () => {
    expect((await cli(['create'])).stderr).toContain('Missing --file');
    expect((await cli(['create', '--file', '/definitely/not/here.json', '--dry-run', '--creator', key('c')])).stderr).toContain('Could not read');
    const r = await cli(['create', '--file', file('{"quoteMint": '), '--dry-run', '--creator', key('c')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not valid JSON');
  });

  it('validates against the schema and lists every problem with where it is', async () => {
    const r = await cli(['create', '--file', file({ quoteMint: 'x', grid: { min: 'abc', tick: '0.05', ticks: 1000 }, window: {}, shards: 99, extra: true }), '--dry-run', '--creator', key('c')]);
    expect(r.code).toBe(2);
    for (const expected of ['is missing "supplyMode"', 'is missing "disclosure"', 'is missing "maxOrders"', 'has an unknown field "extra"', '/shards', '/grid/ticks', '/quoteMint', '/window is missing "close"']) expect(r.stderr, expected).toContain(expected);
  });

  it('refuses a deferred-mint cross with a base mint, an escrow cross with a schedule, and a missing reveal window', async () => {
    const cases: [object, string][] = [
      [{ ...base, supplyMode: 'deferred-mint' }, 'has no base mint yet'],
      [{ ...base, schedule: [{ price: '1', quantity: '1' }] }, 'schedule is for the mint modes'],
      [{ ...base, supplyMode: 'mint' }, 'schedule is required'],
    ];
    for (const [body, message] of cases) {
      const r = await cli(['create', '--file', file(body), '--dry-run', '--creator', key('c')], { fetch: fakeRpc({}, NOW).fetch });
      expect(r.code, message).toBe(2);
      expect(r.stderr).toContain(message);
    }
  });

  it('refuses a file that names a different creator than the signing wallet', async () => {
    const r = await cli(['create', '--file', file({ ...base, creator: key('someone-else') }), '--dry-run', '--creator', key('c')], { fetch: fakeRpc({}, NOW).fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('the signing wallet is');
  });

  it('keeps the published schema file equal to the one the code validates with', () => {
    const published = JSON.parse(readFileSync(new URL('../schemas/create-cross.schema.json', import.meta.url), 'utf8')) as unknown;
    expect(published).toEqual(JSON.parse(JSON.stringify(CREATE_SCHEMA)));
  });
});

describe('reading a cross without an API', () => {
  const accounts = (now: number, over: Record<string, unknown> = {}) => ({ [CROSS_ADDRESS]: { data: crossBytes(now, over), owner: CROSS_CORE_PROGRAM_ADDRESS } });

  it('describes a live cross in words, with the countdown from the cluster’s clock, and reads only the chain', async () => {
    const rpc = fakeRpc(accounts(NOW), NOW);
    const r = await cli(['cross', 'get', CROSS_ADDRESS], { fetch: rpc.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Live (open)');
    expect(r.stdout).toContain('closes in');
    expect(r.stdout).toContain('1h 00m 00s');
    expect(r.stdout).toContain('1 to 1.5 in steps of 0.05');
    expect(r.stdout).toContain('0.25% of proceeds (0.05% protocol, 0.2% integrator); none for buyers');
    expect(new Set(rpc.calls)).toEqual(new Set(['getAccountInfo', 'getSlot', 'getBlockTime']));
  });

  it('prints the same facts as JSON', async () => {
    const r = await cli(['cross', 'get', CROSS_ADDRESS, '--json'], { fetch: fakeRpc(accounts(NOW), NOW).fetch });
    const j = JSON.parse(r.stdout) as { address: string; state: string; grid: { ticks: number }; now: string };
    expect(j).toMatchObject({ address: CROSS_ADDRESS, state: 'Live', grid: { ticks: 11 }, now: String(NOW) });
  });

  it('says plainly when the address is not a cross, is not owned by cross_core, or does not exist', async () => {
    const other = await cli(['cross', 'get', CROSS_ADDRESS], { fetch: fakeRpc({ [CROSS_ADDRESS]: { data: crossBytes(NOW), owner: key('some-other-program') } }, NOW).fetch });
    expect(other.code).toBe(2);
    expect(other.stderr).toContain('is not an Opening Cross account');
    const none = await cli(['cross', 'get', CROSS_ADDRESS], { fetch: fakeRpc({}, NOW).fetch });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('not found on chain');
    const junk = await cli(['cross', 'get', CROSS_ADDRESS], { fetch: fakeRpc({ [CROSS_ADDRESS]: { data: new Uint8Array(200), owner: CROSS_CORE_PROGRAM_ADDRESS } }, NOW).fetch });
    expect(junk.code).toBe(2);
  });

  it('refuses to place an order in a cross that is closed, not open yet or settled, before building anything', async () => {
    const dir = tmp();
    const order = (over: Record<string, unknown>) =>
      cli(['order', 'place', CROSS_ADDRESS, '--side', 'buy', '--price', '1.2', '--quantity', '10', '--dry-run', '--owner', key('o'), '--vault', join(dir, 'v.json')], { fetch: fakeRpc(accounts(NOW, over), NOW).fetch });
    expect((await order({ closeTs: BigInt(NOW - 1), openTs: BigInt(NOW - 100) })).stderr).toContain('past its closing time');
    expect((await order({ openTs: BigInt(NOW + 100) })).stderr).toContain('not open yet');
    expect((await order({ state: 1 })).stderr).toContain('already Cleared');
    for (const r of [await order({ state: 2 })]) expect(r.code).toBe(1);
  });

  it('validates the price and quantity against the grid with a sentence that says what to enter', async () => {
    const dir = tmp();
    const order = (price: string, quantity: string) =>
      cli(['order', 'place', CROSS_ADDRESS, '--side', 'buy', '--price', price, `--quantity=${quantity}`, '--dry-run', '--owner', key('o'), '--vault', join(dir, 'v.json')], { fetch: fakeRpc(accounts(NOW), NOW).fetch });
    expect((await order('1.23', '10')).stderr).toContain('Prices move in steps of 0.05. Try 1.2 or 1.25.');
    expect((await order('0.5', '10')).stderr).toContain('The price must be between 1 and 1.5');
    expect((await order('abc', '10')).stderr).toContain('Enter a price between 1 and 1.5');
    expect((await order('1.2', '0')).stderr).toContain('Enter an amount of tokens');
    expect((await order('1.2', '1.0000001')).stderr).toContain('up to 6 decimal places');
    expect((await order('1.2', '-5')).stderr).toContain('Enter an amount of tokens');
    for (const r of [await order('1.23', '10')]) expect(r.code).toBe(2);
  });
});
