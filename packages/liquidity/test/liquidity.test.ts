import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, getAddressFromPublicKey, getBase58Decoder } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, OrderSide, OrderState, getOrderEncoder, orderAddress, orderCommitment } from '@opening-cross/sdk';
import {
  type CrossFacts,
  type IntentBody,
  type QuoteBody,
  INTENT_SCHEMA,
  QUOTE_SCHEMA,
  checkBacking,
  checkRevealedOrders,
  commitCurve,
  crossCompliance,
  deriveSalt,
  ladder,
  matchCrosses,
  planOrders,
  rebatePoolOf,
  requiredEscrow,
  selfCross,
  signIntent,
  signQuote,
  splitRebate,
  verifyIntent,
  verifyQuote,
} from '../src/index.js';

const NOW = 1_800_000_000;
const NONCE = 'a1b2c3d4e5f60718';

async function party() {
  const kp = await generateKeyPair();
  return { kp, address: await getAddressFromPublicKey(kp.publicKey) };
}
const rand = (): Address => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Address;

const quoteBody = (maker: string, cross: string, over: Partial<QuoteBody> = {}): QuoteBody => ({
  schema: QUOTE_SCHEMA, maker, cross, side: 'buy', price: '1200000', quantity: '5000000', orderNonce: '7', expiresAt: NOW + 600, nonce: NONCE, ...over,
});

describe('signed quotes', () => {
  it('verifies a quote signed by its maker', async () => {
    const m = await party();
    const q = await signQuote(quoteBody(m.address, rand()), m.kp);
    expect(await verifyQuote(q, NOW)).toEqual({ ok: true });
  });

  it('rejects a quote signed by someone else, a changed field, an expired one and an over-long one', async () => {
    const m = await party();
    const other = await party();
    const cross = rand();
    const forged = await signQuote(quoteBody(m.address, cross), other.kp);
    expect(await verifyQuote(forged, NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });

    const good = await signQuote(quoteBody(m.address, cross), m.kp);
    const edited = { ...good, body: { ...good.body, price: '1300000' } };
    expect(await verifyQuote(edited, NOW)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    expect(await verifyQuote(good, NOW + 600)).toEqual({ ok: false, reason: 'EXPIRED' });

    const long = await signQuote(quoteBody(m.address, cross, { expiresAt: NOW + 3 * 86_400 }), m.kp);
    expect(await verifyQuote(long, NOW)).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('refuses malformed bodies before signing', async () => {
    const m = await party();
    await expect(signQuote(quoteBody(m.address, rand(), { quantity: '0' }), m.kp)).rejects.toThrow(/greater than zero/);
    await expect(signQuote(quoteBody(m.address, rand(), { price: '1.5' }), m.kp)).rejects.toThrow(/unsigned 64-bit/);
    await expect(signQuote(quoteBody(m.address, rand(), { nonce: 'XYZ' }), m.kp)).rejects.toThrow(/nonce/);
    await expect(signQuote(quoteBody('not-an-address', rand()), m.kp)).rejects.toThrow(/maker/);
  });
});

describe('quote backing against the chain', () => {
  async function orderAccount(maker: string, cross: string, o: { side: OrderSide; state: OrderState; price: bigint; quantity: bigint }) {
    const data = new Uint8Array(
      getOrderEncoder().encode({ cross: cross as Address, owner: maker as Address, nonce: 7n, index: 0, side: o.side, state: o.state, commitment: new Uint8Array(32), price: o.price, quantity: o.quantity, escrow: 1n, bump: 255 }),
    );
    return { data, owner: CROSS_CORE_PROGRAM_ADDRESS as Address };
  }

  it('is backed by a resting order that matches, and says why when it does not', async () => {
    const m = await party();
    const cross = rand();
    const q = await signQuote(quoteBody(m.address, cross), m.kp);
    const at = await orderAddress(cross, m.address, 7n);
    const read = (acct: { data: Uint8Array; owner: Address } | null) => async (a: Address) => (a === at ? acct : null);

    const ok = await orderAccount(m.address, cross, { side: OrderSide.Buy, state: OrderState.Revealed, price: 1_200_000n, quantity: 6_000_000n });
    expect(await checkBacking(q, read(ok), CROSS_CORE_PROGRAM_ADDRESS as Address)).toEqual({ backed: true, remaining: 6_000_000n });

    expect(await checkBacking(q, read(null), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'NO_ORDER' });
    const sealed = await orderAccount(m.address, cross, { side: OrderSide.Buy, state: OrderState.Committed, price: 0n, quantity: 0n });
    expect(await checkBacking(q, read(sealed), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'NOT_OPEN' });
    const moved = await orderAccount(m.address, cross, { side: OrderSide.Buy, state: OrderState.Revealed, price: 1_100_000n, quantity: 6_000_000n });
    expect(await checkBacking(q, read(moved), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'PRICE_DIFFERS' });
    const small = await orderAccount(m.address, cross, { side: OrderSide.Buy, state: OrderState.Revealed, price: 1_200_000n, quantity: 1_000_000n });
    expect(await checkBacking(q, read(small), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'SIZE_DIFFERS' });
    const wrongSide = await orderAccount(m.address, cross, { side: OrderSide.Sell, state: OrderState.Revealed, price: 1_200_000n, quantity: 6_000_000n });
    expect(await checkBacking(q, read(wrongSide), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'WRONG_SIDE' });
    const foreign = { ...ok, owner: rand() };
    expect(await checkBacking(q, read(foreign), CROSS_CORE_PROGRAM_ADDRESS as Address)).toMatchObject({ backed: false, reason: 'NOT_OWNED_BY_PROGRAM' });
  });
});

describe('ladder', () => {
  const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 11, priceScale: 1_000_000n };

  it('snaps bids down and asks up, merges ticks, and orders best first', () => {
    const l = ladder(
      { buy: [{ price: 1_190_000n, quantity: 10n }, { price: 1_100_000n, quantity: 5n }, { price: 1_150_000n, quantity: 1n }], sell: [{ price: 1_310_000n, quantity: 4n }, { price: 1_400_000n, quantity: 2n }, { price: 1_300_000n, quantity: 1n }] },
      grid,
    );
    expect(l.buy).toEqual([{ price: 1_100_000n, quantity: 16n }]);
    expect(l.sell).toEqual([{ price: 1_300_000n, quantity: 1n }, { price: 1_400_000n, quantity: 4n + 2n }]);
    expect(l.adjusted.length).toBe(3);
    expect(l.dropped).toEqual([]);
  });

  it('drops what the grid cannot hold and clamps what it can without moving the wrong way', () => {
    const l = ladder({ buy: [{ price: 900_000n, quantity: 1n }, { price: 9_000_000n, quantity: 3n }], sell: [{ price: 9_000_000n, quantity: 1n }, { price: 500_000n, quantity: 2n }] }, grid);
    expect(l.dropped.map((d) => d.side)).toEqual(['buy', 'sell']);
    expect(l.buy).toEqual([{ price: 2_000_000n, quantity: 3n }]);
    expect(l.sell).toEqual([{ price: 1_000_000n, quantity: 2n }]);
  });

  it('prices escrow exactly as the program does and finds a maker crossing itself', () => {
    const l = ladder({ buy: [{ price: 1_100_000n, quantity: 3n }], sell: [{ price: 1_300_000n, quantity: 7n }] }, grid);
    expect(requiredEscrow(l, grid.priceScale)).toEqual({ quote: 4n, base: 7n }); // ceil(3 * 1.1) = 4
    expect(selfCross(l)).toBeNull();
    const crossed = ladder({ buy: [{ price: 1_300_000n, quantity: 1n }], sell: [{ price: 1_300_000n, quantity: 1n }] }, grid);
    expect(selfCross(crossed)).toEqual({ bid: 1_300_000n, ask: 1_300_000n });
  });

  it('rejects an invalid grid and an empty step', () => {
    expect(() => ladder({ buy: [], sell: [] }, { ...grid, tick: 0n })).toThrow(/grid/);
    expect(() => ladder({ buy: [{ price: 1_000_000n, quantity: 0n }], sell: [] }, grid)).toThrow(/positive/);
  });
});

describe('sealed liquidity', () => {
  const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 11, priceScale: 1_000_000n };
  const master = crypto.getRandomValues(new Uint8Array(32));

  it('derives one salt per order and plans commitments the program would accept', async () => {
    const maker = await party();
    const cross = rand();
    const l = ladder({ buy: [{ price: 1_100_000n, quantity: 3n }, { price: 1_000_000n, quantity: 2n }], sell: [{ price: 1_300_000n, quantity: 5n }] }, grid);
    const plan = planOrders({ cross, owner: maker.address, ladder: l, firstNonce: 40n, master });
    expect(plan.map((p) => [p.nonce, p.side])).toEqual([[40n, 'buy'], [41n, 'buy'], [42n, 'sell']]);
    expect(new Set(plan.map((p) => Buffer.from(p.salt!).toString('hex'))).size).toBe(3);
    const first = plan[0]!;
    expect(first.salt).toEqual(deriveSalt(master, cross, maker.address, 40n));
    expect(first.commitment).toEqual(orderCommitment(cross, maker.address, 40n, OrderSide.Buy, first.price, first.quantity, first.salt!));
    expect(planOrders({ cross, owner: maker.address, ladder: l, firstNonce: 1n }).every((p) => p.salt === undefined)).toBe(true);
    expect(() => deriveSalt(new Uint8Array(8), cross, maker.address, 1n)).toThrow(/32 bytes/);
  });

  it('commits to a curve and detects a different book at the reveal', async () => {
    const maker = await party();
    const cross = rand();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const l = ladder({ buy: [{ price: 1_100_000n, quantity: 3n }], sell: [{ price: 1_300_000n, quantity: 5n }] }, grid);
    const c = commitCurve(cross, maker.address, l, secret);
    const revealed = [{ side: 'buy' as const, price: 1_100_000n, quantity: 3n }, { side: 'sell' as const, price: 1_300_000n, quantity: 5n }];
    expect(checkRevealedOrders(c, cross, maker.address, revealed, secret)).toBe(true);
    expect(checkRevealedOrders(c, cross, maker.address, [revealed[0]!, { ...revealed[1]!, quantity: 6n }], secret)).toBe(false);
    expect(checkRevealedOrders(c, cross, maker.address, revealed, new Uint8Array(32))).toBe(false);
    expect(() => commitCurve(cross, maker.address, l, new Uint8Array(4))).toThrow(/16 bytes/);
  });
});

describe('maker obligations and the rebate', () => {
  const rule = { minQuantity: 100n, maxSpreadBps: 500 };
  const scale = 1_000_000n;
  const o = (side: 'buy' | 'sell', price: bigint, quantity: bigint, status: 'revealed' | 'cancelled' | 'committed' | 'claimed' = 'revealed') => ({ side, price, quantity, status });

  it('counts a two-sided book inside the spread and weighs the thinner side', () => {
    const r = crossCompliance([o('buy', 1_000_000n, 200n), o('sell', 1_040_000n, 150n)], rule, scale);
    expect(r.compliant).toBe(true);
    expect(r.spreadBps).toBe(393); // 40_000 / 1_020_000 = 392.2, rounded up
    expect(r.weight).toBe(156n); // min(200, 156)
  });

  it('does not count cancelled or never-revealed orders, a wide spread, a thin side or a self-cross', () => {
    expect(crossCompliance([o('buy', 1_000_000n, 200n, 'cancelled'), o('sell', 1_040_000n, 150n)], rule, scale).reasons[0]).toMatch(/bids total 0/);
    expect(crossCompliance([o('buy', 1_000_000n, 200n, 'committed'), o('sell', 1_040_000n, 150n)], rule, scale).compliant).toBe(false);
    expect(crossCompliance([o('buy', 900_000n, 200n), o('sell', 1_100_000n, 150n)], rule, scale).reasons.join()).toMatch(/spread is 2000 bps/);
    expect(crossCompliance([o('buy', 1_000_000n, 50n), o('sell', 1_010_000n, 150n)], rule, scale).compliant).toBe(false);
    const self = crossCompliance([o('buy', 1_010_000n, 200n), o('sell', 1_000_000n, 200n)], rule, scale);
    expect(self.compliant).toBe(false);
    expect(self.weight).toBe(0n);
  });

  it('funds the pool only from reopens and never pays out more than the pool, whatever the order', () => {
    expect(rebatePoolOf('reopen', 10_000n)).toBe(2_500n);
    expect(rebatePoolOf('launch', 10_000n)).toBe(0n);
    const w = new Map([['b', 3n], ['a', 1n], ['c', 0n]]);
    const s = splitRebate(1_001n, w);
    expect([...s.shares.entries()]).toEqual([['a', 250n], ['b', 750n]]);
    expect(s.undistributed).toBe(1n);
    const reversed = splitRebate(1_001n, new Map([...w.entries()].reverse()));
    expect(reversed.shares).toEqual(s.shares);
    expect(splitRebate(500n, new Map()).undistributed).toBe(500n);
    expect(() => splitRebate(-1n, w)).toThrow();
    let sum = 0n;
    for (const v of splitRebate(999_999n, new Map([['x', 7n], ['y', 11n], ['z', 13n]])).shares.values()) sum += v;
    expect(sum <= 999_999n).toBe(true);
  });
});

describe('intents', () => {
  const body = (owner: string, over: Partial<IntentBody> = {}): IntentBody => ({
    schema: INTENT_SCHEMA, owner, baseMint: rand(), quoteMint: rand(), side: 'buy', quantity: '1000000', limitPrice: '1300000', expiresAt: NOW + 3600, nonce: NONCE, ...over,
  });

  it('signs, verifies and refuses tampering and expiry', async () => {
    const m = await party();
    const s = await signIntent(body(m.address), m.kp);
    expect(await verifyIntent(s, NOW)).toEqual({ ok: true });
    expect(await verifyIntent({ ...s, body: { ...s.body, quantity: '2000000' } }, NOW)).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    expect(await verifyIntent(s, NOW + 3600)).toEqual({ ok: false, reason: 'EXPIRED' });
    const other = await party();
    expect(await verifyIntent(await signIntent(body(m.address), other.kp), NOW)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    await expect(signIntent(body(m.address, { limitPrice: '0' }), m.kp)).rejects.toThrow(/limitPrice/);
    await expect(signIntent(body(m.address, { baseMint: m.address, quoteMint: m.address }), m.kp)).rejects.toThrow(/differ/);
  });

  it('says why each cross is or is not eligible', () => {
    const base = rand();
    const quote = rand();
    const intent = body(rand(), { baseMint: base, quoteMint: quote });
    const c = (over: Partial<CrossFacts>): CrossFacts => ({ address: rand(), state: 'Live', baseMint: base, quoteMint: quote, openTs: 100n, closeTs: 10_000n, sealed: false, ...over });
    const out = matchCrosses(intent, [c({}), c({ quoteMint: rand() }), c({ state: 'Finalized' }), c({ openTs: 9_000n }), c({ closeTs: 1_010n }), c({ closeTs: 900n })], 1_000n);
    expect(out.map((m) => m.reason)).toEqual([null, 'trades a different pair', 'is Finalized, not Live', 'has not opened yet', 'closes in under 30 s, too late to be sure a transaction lands', 'has closed']);
  });
});
