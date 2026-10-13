// Trade from a link (S10): the Solana Actions metadata and the bid transaction, and sponsored fees (I6, S14), over HTTP with
// accounts injected in memory. The transactions are decoded and their instructions read, not only checked for existence.
import { beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { type Address, generateKeyPairSigner, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { PGlite } from '@electric-sql/pglite';
import { CROSS_CORE_PROGRAM_ADDRESS, ata, getOrderSize, orderAddress } from '@opening-cross/sdk';
import { RequestError } from '../src/tx.js';
import { registerHolderActions } from '../src/routes/holder-actions.js';
import { advanceNeeded, registerHolderSponsor, transferInstruction } from '../src/routes/holder-sponsor.js';
import { holderDb } from './helpers/holder-pg.js';
import { TOKEN_PROGRAM, type TestCross, makeCross, tokenAccount } from './helpers/holder-cross.js';

const NOW = 1_500;
const lifetime = async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n });

function decodeTx(b64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, msg };
}

function errorHandler(app: ReturnType<typeof Fastify>) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message });
    return reply.code(500).send({ error: String(err) });
  });
}

describe('Solana Actions for a cross', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  let open: TestCross, sealed: TestCross, upcoming: TestCross, closed: TestCross;
  let app: ReturnType<typeof Fastify>;
  let bidder: Address;
  let now = NOW;

  beforeAll(async () => {
    [open, sealed, upcoming, closed] = await Promise.all([makeCross(), makeCross({ disclosure: 0 }), makeCross({ openTs: 5_000n, closeTs: 6_000n, revealEndTs: 6_000n }), makeCross({ state: 3 })]);
    for (const c of [open, sealed, upcoming, closed]) accounts.set(c.address, c.account);
    bidder = (await generateKeyPairSigner()).address;
    app = Fastify();
    errorHandler(app);
    registerHolderActions(app, { account: async (a) => accounts.get(a) ?? null, lifetime, clock: () => now, webUrl: 'https://app.example' });
    await app.ready();
  });

  it('describes an open cross with an absolute icon and a two-field bid form', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/actions/crosses/${open.address}`, headers: { host: 'api.example' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const b = r.json();
    expect(b).toMatchObject({ type: 'action', icon: 'https://app.example/icon.svg', label: 'Place a bid' });
    expect(b.disabled).toBeUndefined();
    expect(b.title).toContain('Opening Bell');
    expect(b.description).toContain('one clearing price');
    const a = b.links.actions[0];
    expect(a.href).toBe(`http://api.example/v1/actions/crosses/${open.address}/bid?price={price}&quantity={quantity}`);
    expect(a.parameters.map((p: { name: string }) => p.name)).toEqual(['price', 'quantity']);
    expect(a.parameters.every((p: { required: boolean }) => p.required)).toBe(true);
  });

  it('disables the action, with the reason, for a sealed, upcoming or settled cross', async () => {
    const read = async (c: TestCross) => (await app.inject(`/v1/actions/crosses/${c.address}`)).json();
    expect(await read(sealed)).toMatchObject({ disabled: true });
    expect((await read(sealed)).error.message).toContain('sealed');
    expect((await read(upcoming)).error.message).toContain('opens at');
    expect((await read(closed)).error.message).toContain('settled');
  });

  it('answers a non-cross address and a junk address in the spec error shape', async () => {
    const other = (await generateKeyPairSigner()).address;
    const a = await app.inject(`/v1/actions/crosses/${other}`);
    expect(a.statusCode).toBe(404);
    expect(a.json()).toEqual({ message: expect.stringContaining('not an Opening Cross account') });
    const b = await app.inject('/v1/actions/crosses/not-an-address');
    expect(b.statusCode).toBe(400);
    expect(b.json().message).toContain('base58');
  });

  it('builds the bid transaction a wallet will sign, with the escrow it will hold', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/actions/crosses/${open.address}/bid?price=1.5&quantity=100`, payload: { account: bidder } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.type).toBe('transaction');
    expect(body.message).toContain('Bid for 100 tokens at up to 1.5');
    expect(body.message).toContain('Up to 150 is held in escrow');
    const { msg } = decodeTx(body.transaction);
    expect(msg.staticAccounts[0]).toBe(bidder);
    expect(msg.staticAccounts).toContain(CROSS_CORE_PROGRAM_ADDRESS);
    expect(msg.instructions).toHaveLength(1);
  });

  it('refuses a bid it cannot make: wrong price step, junk numbers, no account, sealed, closed, not open yet', async () => {
    const post = (cross: TestCross, q: string, payload: unknown = { account: bidder }) => app.inject({ method: 'POST', url: `/v1/actions/crosses/${cross.address}/bid?${q}`, payload: payload as never });
    const step = await post(open, 'price=1.55&quantity=1');
    expect(step.statusCode).toBe(400);
    expect(step.json().message).toContain('steps of');
    expect((await post(open, 'price=abc&quantity=1')).statusCode).toBe(400);
    expect((await post(open, 'price=1.5&quantity=0')).statusCode).toBe(400);
    expect((await post(open, 'price=1.5&quantity=-3')).statusCode).toBe(400);
    expect((await post(open, 'price=1.5')).statusCode).toBe(400);
    expect((await post(open, 'price=9&quantity=1')).statusCode).toBe(400);
    expect((await post(open, 'price=1.5&quantity=1', {})).statusCode).toBe(400);
    expect((await post(open, 'price=1.5&quantity=1', { account: 'nope' })).statusCode).toBe(400);
    expect((await post(sealed, 'price=1.5&quantity=1')).statusCode).toBe(409);
    expect((await post(upcoming, 'price=1.5&quantity=1')).statusCode).toBe(409);
    expect((await post(closed, 'price=1.5&quantity=1')).statusCode).toBe(409);
    now = 2_500;
    expect((await post(open, 'price=1.5&quantity=1')).statusCode).toBe(409);
    now = NOW;
  });

  it('says plainly that it cannot give an icon when the deployment has no web address', async () => {
    const bare = Fastify();
    errorHandler(bare);
    registerHolderActions(bare, { account: async (a) => accounts.get(a) ?? null, lifetime, clock: () => now, webUrl: null });
    await bare.ready();
    const r = await bare.inject(`/v1/actions/crosses/${open.address}`);
    expect(r.statusCode).toBe(503);
    expect(r.json().message).toContain('WEB_URL');
  });
});

describe('sponsored orders', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const balances = new Map<string, bigint>();
  let db: PGlite;
  let cross: TestCross;
  let sponsor: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let owner: Address;
  let app: ReturnType<typeof Fastify>;
  let counter = 1;
  const RENT = 1_650_000n;

  const fund = async (w: Address, amount = 1_000_000_000n) => void accounts.set(await ata(w, cross.quoteMint, TOKEN_PROGRAM), tokenAccount(w, cross.quoteMint, amount));
  const body = (over: Record<string, unknown> = {}) => ({ cross: cross.address, owner, side: 'buy', price: '1500000', quantity: '100000000', nonce: String(counter++), ...over });
  const post = (payload: unknown, a = app) => a.inject({ method: 'POST', url: '/v1/tx/place-order-sponsored', payload: payload as never });

  async function build(limits = {}) {
    const a = Fastify();
    errorHandler(a);
    registerHolderSponsor(a, {
      db,
      account: async (x) => accounts.get(x) ?? null,
      lifetime,
      clock: () => NOW,
      sponsor,
      balance: async (x) => balances.get(x) ?? 0n,
      rentFor: async (n) => (n === getOrderSize() ? RENT : 0n),
      limits,
    });
    await a.ready();
    return a;
  }

  beforeAll(async () => {
    db = await holderDb();
    cross = await makeCross();
    accounts.set(cross.address, cross.account);
    sponsor = await generateKeyPairSigner();
    owner = (await generateKeyPairSigner()).address;
    await fund(owner);
    balances.set(sponsor.address, 10_000_000_000n);
    app = await build();
  });

  it('computes the advance a wallet needs', () => {
    expect(advanceNeeded(0n, 1_650_000n)).toBe(1_650_000n);
    expect(advanceNeeded(1_000_000n, 1_650_000n)).toBe(650_000n);
    expect(advanceNeeded(1_650_000n, 1_650_000n)).toBe(0n);
    expect(advanceNeeded(5_000_000n, 1_650_000n)).toBe(0n);
  });

  it('encodes the system transfer the way the system program decodes it', () => {
    const ix = transferInstruction('11111111111111111111111111111112' as Address, '11111111111111111111111111111113' as Address, 1_650_000n);
    expect(Array.from(ix.data!.slice(0, 4))).toEqual([2, 0, 0, 0]);
    expect(new DataView(ix.data!.buffer).getBigUint64(4, true)).toBe(1_650_000n);
    expect(ix.accounts).toHaveLength(2);
  });

  it('reports itself off when it has no key, and refuses to sign', async () => {
    const off = Fastify();
    errorHandler(off);
    registerHolderSponsor(off, { db, account: async () => null, lifetime, sponsor: null });
    await off.ready();
    expect((await off.inject('/v1/sponsor')).json()).toMatchObject({ enabled: false });
    expect((await off.inject({ method: 'POST', url: '/v1/tx/place-order-sponsored', payload: {} })).statusCode).toBe(503);
  });

  it('signs a two-instruction transaction for a wallet with no SOL: the sponsor pays the fee and tops up the rent', async () => {
    const payload = body({ nonce: '777' });
    const r = await post(payload);
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out.sponsored).toEqual({ feePayer: sponsor.address, advanceLamports: String(RENT), feeLamports: '10000' });
    expect(out.signers).toEqual([owner]);
    expect(out.order).toBe(await orderAddress(cross.address, owner, 777n));
    const { tx, msg } = decodeTx(out.transaction);
    expect(msg.staticAccounts[0]).toBe(sponsor.address);
    expect(msg.instructions).toHaveLength(2);
    // The sponsor's signature is present and the owner's slot is empty, waiting for the wallet.
    expect(tx.signatures[sponsor.address]).toBeTruthy();
    expect(tx.signatures[owner]).toBeNull();
    // First instruction: a system transfer of exactly the advance from the sponsor to the owner.
    const transfer = msg.instructions[0]!;
    expect(msg.staticAccounts[transfer.programAddressIndex]).toBe('11111111111111111111111111111111');
    expect(new DataView(transfer.data!.buffer, transfer.data!.byteOffset).getBigUint64(4, true)).toBe(RENT);
    // Second: cross_core's commit_order.
    expect(msg.staticAccounts[msg.instructions[1]!.programAddressIndex]).toBe(CROSS_CORE_PROGRAM_ADDRESS);
  });

  it('tops up only the shortfall and adds nothing for a wallet that already has the rent', async () => {
    balances.set(owner, 1_000_000n);
    expect((await post(body())).json().sponsored.advanceLamports).toBe(String(RENT - 1_000_000n));
    balances.set(owner, 5_000_000n);
    const r = (await post(body())).json();
    expect(r.sponsored.advanceLamports).toBe('0');
    expect(decodeTx(r.transaction).msg.instructions).toHaveLength(1);
    balances.delete(owner);
  });

  it('refuses what would fail anyway, because the sponsor pays the fee even for a failed transaction', async () => {
    const e = (over: Record<string, unknown>) => post(body(over));
    expect((await e({ price: '1550000' })).statusCode).toBe(400);
    expect((await e({ price: '9000000' })).statusCode).toBe(400);
    expect((await e({ quantity: '0' })).statusCode).toBe(400);
    expect((await e({ side: 'hold' })).statusCode).toBe(400);
    expect((await e({ nonce: 'abc' })).statusCode).toBe(400);
    expect((await e({ owner: 'nope' })).statusCode).toBe(400);
    expect((await e({ owner: sponsor.address })).statusCode).toBe(400);
    const poor = (await generateKeyPairSigner()).address;
    const noTokens = await e({ owner: poor });
    expect(noTokens.statusCode).toBe(409);
    expect(noTokens.json().error).toContain('Sponsorship pays fees, not escrow');
    expect((await e({ quantity: '900000000000' })).statusCode).toBe(409);
    expect((await e({ cross: (await generateKeyPair()).address })).statusCode).toBe(404);
  });

  it('refuses a cross that is not taking orders', async () => {
    const closed = await makeCross({ state: 3 });
    const later = await makeCross({ openTs: 9_000n, closeTs: 9_900n, revealEndTs: 9_900n });
    accounts.set(closed.address, closed.account);
    accounts.set(later.address, later.account);
    expect((await post(body({ cross: closed.address }))).statusCode).toBe(409);
    expect((await post(body({ cross: later.address }))).statusCode).toBe(409);
  });

  it('limits each wallet per day and the sponsor per day, and says so', async () => {
    const lim = await build({ perWalletPerDay: 2, dailyLamports: 100_000_000n });
    const w = (await generateKeyPairSigner()).address;
    await fund(w);
    expect((await post(body({ owner: w }), lim)).statusCode).toBe(200);
    expect((await post(body({ owner: w }), lim)).statusCode).toBe(200);
    const third = await post(body({ owner: w }), lim);
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toContain('2 sponsored orders per day');
    const status = (await lim.inject('/v1/sponsor')).json();
    expect(status).toMatchObject({ enabled: true, sponsor: sponsor.address, perWalletPerDay: 2 });
    expect(BigInt(status.spentTodayLamports)).toBeGreaterThan(0n);

    const tiny = await build({ perWalletPerDay: 50, dailyLamports: 100_000n });
    const w2 = (await generateKeyPairSigner()).address;
    await fund(w2);
    const r = await post(body({ owner: w2 }), tiny);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain('limit for today');
  });

  it('stops when the sponsor itself is nearly empty', async () => {
    const was = balances.get(sponsor.address)!;
    balances.set(sponsor.address, 500_000n);
    const w = (await generateKeyPairSigner()).address;
    await fund(w);
    const r = await post(body({ owner: w }));
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain('out of funds');
    balances.set(sponsor.address, was);
  });
});

async function generateKeyPair() {
  return generateKeyPairSigner();
}
