// cross_basket over HTTP with accounts injected in memory: the release gate, the rounding the program uses (up on a mint, down on a redemption), the components the
// program refuses, balances, and every built transaction decoded back to its instructions. The program is not run here (tests/core/test/basket.test.ts runs it).
import { describe, expect, it } from 'vitest';
import {
  CREATE_BASKET_DISCRIMINATOR,
  MINT_SHARES_DISCRIMINATOR,
  REDEEM_SHARES_DISCRIMINATOR,
  findBasketPda,
  findShareMintPda,
  getBasketEncoder,
  getCreateBasketInstructionDataDecoder,
  getMintSharesInstructionDataDecoder,
} from '@opening-cross/cross-basket-client';
import { CROSS_BASKET_PROGRAM_ADDRESS, ata, basketOwed } from '@opening-cross/sdk';
import { registerBasketTx } from '../src/routes/basket-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, T22, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

async function fixture() {
  const chain = new Chain();
  const [creator, user, a, b, c] = await Promise.all([key(), key(), key(), key(), key()]);
  chain.mint(a, { decimals: 6 });
  chain.mint(b, { decimals: 6, program: T22 });
  chain.mint(c, { decimals: 6 });
  chain.deploy('crossBasket');
  const basket = (await findBasketPda({ creator, id: 0n }))[0];
  const shareMint = (await findShareMintPda({ basket }))[0];
  chain.mint(shareMint, { decimals: 6, supply: 3_000_000n });
  const components = [
    { mint: a, tokenProgram: SPL, unitsPerShare: 2_000_000n },
    { mint: b, tokenProgram: T22, unitsPerShare: 750_000n },
    { mint: c, tokenProgram: SPL, unitsPerShare: 7n },
  ];
  chain.put(basket, CROSS_BASKET_PROGRAM_ADDRESS, getBasketEncoder().encode({ creator, id: 0n, shareMint, label: 'majors', components, bump: 1 }));
  // vaults cover 3,000,000 share atoms (3 shares): 6,000,000 / 2,250,000 / 21
  await chain.token(basket, a, 6_000_000n);
  await chain.token(basket, b, 2_250_001n, T22);
  await chain.token(basket, c, 21n);
  for (const comp of components) await chain.token(user, comp.mint, 100_000_000n, comp.tokenProgram);
  await chain.token(user, shareMint, 1_500_000n);
  const app = server();
  registerBasketTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  return { chain, creator, user, a, b, c, basket, shareMint, components, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_BASKET_PROGRAM_ADDRESS);

describe('cross_basket', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    registerBasketTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    expect((await c.post('/v1/tx/basket-create', { creator: f.creator, label: 'x', components: [{ mint: f.a, unitsPerShare: '1' }] })).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.post('/v1/tx/basket-mint', { user: f.user, basket: f.basket, shares: '1' })).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.post('/v1/tx/basket-redeem', { user: f.user, basket: f.basket, shares: '1' })).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get(`/v1/baskets/${f.basket}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get(`/v1/baskets/${f.basket}/quote?shares=1&side=mint`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get('/v1/baskets')).body).toMatchObject({ baskets: [], release: { deployed: false } });
  }, 30_000);

  it('creates a basket: the vault accounts first, the next free id, mixed legacy and Token-2022 components', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/basket-create', { creator: f.creator, label: 'pair', components: [{ mint: f.a, unitsPerShare: '5' }, { mint: f.b, unitsPerShare: '9' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const next = (await findBasketPda({ creator: f.creator, id: 1n }))[0];
    expect(r.body).toMatchObject({ basket: next, id: '1', shareDecimals: 6 });
    expect(r.body.components.map((x: { tokenProgram: string }) => x.tokenProgram)).toEqual([SPL, T22]);
    const ixs = decode(r.body.transaction);
    expect(ixs.filter((i) => i.programAddress === ATA_PROGRAM)).toHaveLength(2);
    const create = programIxs(r.body.transaction)[0]!;
    expect(startsWith(create, CREATE_BASKET_DISCRIMINATOR)).toBe(true);
    expect(getCreateBasketInstructionDataDecoder().decode(create.data!)).toMatchObject({ id: 1n, label: 'pair', unitsPerShare: [5n, 9n] });
    // the create instruction's remaining accounts: mint then the basket's vault, per component
    const accounts = create.accounts!.map((x) => x.address);
    expect(accounts).toEqual(expect.arrayContaining([f.a, await ata(next, f.a, SPL), f.b, await ata(next, f.b, T22)]));
  });

  it('refuses what the program refuses: no component, nine components, a duplicate, a zero amount, a long label, a hostile extension, a missing mint', async () => {
    const f = await fixture();
    const create = (body: Record<string, unknown>) => f.post('/v1/tx/basket-create', { creator: f.creator, label: 'x', components: [{ mint: f.a, unitsPerShare: '1' }], ...body });
    expect((await create({ components: [] })).body.reason).toBe('BAD_BASKET');
    const many = await Promise.all(Array.from({ length: 9 }, async () => key()));
    for (const m of many) f.chain.mint(m);
    expect((await create({ components: many.map((m) => ({ mint: m, unitsPerShare: '1' })) })).body.reason).toBe('BAD_BASKET');
    expect((await create({ components: [{ mint: f.a, unitsPerShare: '1' }, { mint: f.a, unitsPerShare: '2' }] })).body.reason).toBe('DUPLICATE_COMPONENT');
    expect((await create({ components: [{ mint: f.a, unitsPerShare: '0' }] })).body.reason).toBe('BAD_BASKET');
    expect((await create({ label: 'x'.repeat(33) })).body.reason).toBe('BAD_BASKET');
    expect((await create({ components: [{ mint: await key(), unitsPerShare: '1' }] })).body.reason).toBe('MINT_NOT_FOUND');
    expect((await create({ components: [{ mint: f.basket, unitsPerShare: '1' }] })).body.reason).toBe('NOT_A_TOKEN_MINT');
    // a Token-2022 mint with a transfer fee extension: type 1 at offset 166
    const fee = await key();
    const data = new Uint8Array(166 + 4 + 108);
    data[165] = 1;
    new DataView(data.buffer).setUint16(166, 1, true);
    new DataView(data.buffer).setUint16(168, 108, true);
    f.chain.put(fee, T22, data);
    const hostile = await create({ components: [{ mint: fee, unitsPerShare: '1' }] });
    expect(hostile.status).toBe(422);
    expect(hostile.body.reason).toBe('UNSAFE_EXTENSION');
    expect((await create({ components: 'a' })).status).toBe(400);
    expect((await create({ label: 5 })).status).toBe(400);
  });

  it('mints shares: every component paid in, rounded up to the next atom, checked against the user\'s balances', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/basket-mint', { user: f.user, basket: f.basket, shares: '1500000' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 1.5 shares: 3,000,000 + 1,125,000 + ceil(10.5) = 11
    expect(r.body.deposits.map((d: { amount: string }) => d.amount)).toEqual(['3000000', '1125000', '11']);
    expect(r.body.deposits[2].exact).toBe(false);
    expect(r.body.rounding).toMatch(/up/);
    expect(basketOwed(7n, 1_500_000n, true)).toBe(11n);
    const ixs = decode(r.body.transaction);
    expect(ixs.filter((i) => i.programAddress === ATA_PROGRAM)).toHaveLength(1); // the user's share account
    const mint = programIxs(r.body.transaction)[0]!;
    expect(startsWith(mint, MINT_SHARES_DISCRIMINATOR)).toBe(true);
    expect(getMintSharesInstructionDataDecoder().decode(mint.data!).shares).toBe(1_500_000n);
    // three accounts per component: the mint, the basket's vault, the user's account
    const accounts = mint.accounts!.map((x) => x.address);
    for (const comp of f.components) expect(accounts).toEqual(expect.arrayContaining([comp.mint, await ata(f.basket, comp.mint, comp.tokenProgram), await ata(f.user, comp.mint, comp.tokenProgram)]));
    // a user short of one component moves nothing
    await f.chain.token(f.user, f.a, 2_999_999n);
    const short = await f.post('/v1/tx/basket-mint', { user: f.user, basket: f.basket, shares: '1500000' });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({ reason: 'INSUFFICIENT_COMPONENT', mint: f.a, have: '2999999', need: '3000000' });
    expect((await f.post('/v1/tx/basket-mint', { user: f.user, basket: f.basket, shares: '0' })).status).toBe(400);
    expect((await f.post('/v1/tx/basket-mint', { user: f.user, basket: f.creator, shares: '1' })).status).toBe(404);
  });

  it('redeems shares: every component paid out, rounded down, the redeemer\'s accounts created first, and no more shares than the user holds', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/basket-redeem', { user: f.user, basket: f.basket, shares: '1500000' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.payouts.map((d: { amount: string }) => d.amount)).toEqual(['3000000', '1125000', '10']);
    expect(r.body.rounding).toMatch(/down/);
    const ixs = decode(r.body.transaction);
    expect(ixs.filter((i) => i.programAddress === ATA_PROGRAM).length).toBe(3); // the redeemer's account for each component
    expect(startsWith(programIxs(r.body.transaction)[0]!, REDEEM_SHARES_DISCRIMINATOR)).toBe(true);
    const over = await f.post('/v1/tx/basket-redeem', { user: f.user, basket: f.basket, shares: '1500001' });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ reason: 'INSUFFICIENT_SHARES', have: '1500000' });
  });

  it('reads a basket from chain: vault balances, the share supply, backing per share, solvency; and quotes the rounding', async () => {
    const f = await fixture();
    const r = await f.get(`/v1/baskets/${f.basket}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ basket: f.basket, label: 'majors', shareSupply: '3000000', solvent: true });
    expect(r.body.components.map((c: { backingPerShare: string }) => c.backingPerShare)).toEqual(['2000000', '750000', '7']);
    expect(r.body.components.map((c: { covers: boolean }) => c.covers)).toEqual([true, true, true]);
    // one atom of the third component missing: the basket is not solvent
    await f.chain.token(f.basket, f.c, 20n);
    expect((await f.get(`/v1/baskets/${f.basket}`)).body.solvent).toBe(false);
    const q = await f.get(`/v1/baskets/${f.basket}/quote?shares=1&side=mint`);
    expect(q.body.lines.map((l: { amount: string }) => l.amount)).toEqual(['2', '1', '1']);
    const rq = await f.get(`/v1/baskets/${f.basket}/quote?shares=1&side=redeem`);
    expect(rq.body.lines.map((l: { amount: string }) => l.amount)).toEqual(['2', '0', '0']);
    expect((await f.get(`/v1/baskets/${f.basket}/quote?shares=1&side=sideways`)).status).toBe(400);
    expect((await f.get(`/v1/baskets/${f.basket}/quote?side=mint`)).status).toBe(400);
  });

  it('lists baskets from the index with the shares outstanding', async () => {
    const f = await fixture();
    const { db, pg } = await database();
    const app = server();
    registerBasketTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    await pg.query(`INSERT INTO baskets (address, creator, share_mint, components, minted, redeemed, created_slot, updated_slot) VALUES ($1,$2,$3,'[]',5000000,2000000,3,4)`, [f.basket, f.creator, f.shareMint]);
    const list = await caller(app).get(`/v1/baskets?creator=${f.creator}`);
    expect(list.body.baskets).toEqual([{ basket: f.basket, creator: f.creator, shareMint: f.shareMint, components: [], minted: '5000000', redeemed: '2000000', outstanding: '3000000', createdSlot: '3' }]);
    expect((await caller(app).get(`/v1/baskets?creator=${f.user}`)).body.baskets).toEqual([]);
  }, 30_000);
});
