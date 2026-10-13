import { describe, expect, it } from 'vitest';
import type { BookResponse, BuiltAction, CrossDetail, CrossSummary, OrderLookup, OwnerOrder } from '@opening-cross/client';
import { deriveSalt } from '@opening-cross/liquidity';
import { type BotApi, type BotChain, type BotState, MarketMaker, emptyState } from '../src/bot.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { buildQuote, chooseReference, validateStrategy } from '../src/strategy.js';

const GRID = { minPrice: 1_000_000n, tick: 50_000n, ticks: 41, priceScale: 1_000_000n }; // 1.00 to 3.00
const S = { halfSpreadBps: 200, levels: 2, stepBps: 100, quoteBudget: 2_000_000_000n, baseBudget: 1_000_000_000n, minSecondsLeft: 45 };

describe('strategy', () => {
  it('quotes both sides around the reference, inside the budget and the inventory', () => {
    const p = buildQuote(1_500_000n, S, GRID, { quote: 10_000_000_000n, base: 10_000_000_000n }, true);
    expect(p.kind).toBe('quote');
    if (p.kind !== 'quote') return;
    // 2% and 3% away: bids 1.47 and 1.455 snap down to 1.45 and 1.45, asks 1.53 and 1.545 snap up to 1.55 and 1.55.
    expect(p.ladder.buy.map((s) => s.price)).toEqual([1_450_000n]);
    expect(p.ladder.sell.map((s) => s.price)).toEqual([1_550_000n]);
    expect(p.escrow.quote <= S.quoteBudget).toBe(true);
    expect(p.escrow.base).toBe(1_000_000_000n);
  });

  it('spends no more than the wallet holds and says so when it has too little', () => {
    const p = buildQuote(1_500_000n, S, GRID, { quote: 100_000n, base: 0n }, true);
    expect(p.kind).toBe('quote');
    if (p.kind === 'quote') {
      expect(p.escrow.quote <= 100_000n).toBe(true);
      expect(p.notes.join()).toMatch(/no asks/);
    }
    expect(buildQuote(1_500_000n, S, GRID, { quote: 0n, base: 0n }, true)).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/too small/) });
  });

  it('places no asks in a cross that mints its supply', () => {
    const p = buildQuote(1_500_000n, S, GRID, { quote: 10_000_000_000n, base: 10_000_000_000n }, false);
    expect(p.kind === 'quote' && p.ladder.sell.length).toBe(0);
    expect(p.kind === 'quote' && p.notes.join()).toMatch(/mints its supply/);
  });

  it('refuses a reference the grid cannot hold and an invalid strategy', () => {
    expect(buildQuote(100_000_000n, S, GRID, { quote: 10n ** 12n, base: 10n ** 12n }, true).kind).toBe('quote'); // clamps the bid to the top tick
    expect(buildQuote(0n, S, GRID, { quote: 1n, base: 1n }, true)).toMatchObject({ kind: 'skip' });
    expect(() => validateStrategy({ ...S, levels: 9 })).toThrow(/levels/);
    expect(() => validateStrategy({ ...S, halfSpreadBps: 9_950, levels: 2, stepBps: 100 })).toThrow(/zero price/);
    expect(() => validateStrategy({ ...S, halfSpreadBps: 0 })).toThrow(/halfSpreadBps/);
  });

  it('takes the reference in a fixed order and never invents one', () => {
    const all = { configured: 3n, lastPrint: { price: 2n, cross: 'X' }, indicative: 1n };
    expect(chooseReference(all)?.source).toBe('configured');
    expect(chooseReference({ ...all, configured: null })?.source).toBe('last-print');
    expect(chooseReference({ ...all, configured: null, lastPrint: null })?.source).toBe('indicative');
    expect(chooseReference({ configured: null, lastPrint: null, indicative: null })).toBeNull();
    expect(chooseReference({ configured: 0n, lastPrint: null, indicative: 0n })).toBeNull();
  });
});

describe('config', () => {
  const base = { API_URL: 'https://api.example/', RPC_URL: 'https://rpc.example', MM_KEYPAIR: 'k.json', MM_QUOTE_BUDGET: '1000', MM_BASE_BUDGET: '2000' };
  it('reads a complete environment with the documented defaults', () => {
    const c = loadConfig(base);
    expect(c.apiUrl).toBe('https://api.example');
    expect(c.strategy).toMatchObject({ halfSpreadBps: 200, levels: 3, stepBps: 100, quoteBudget: 1000n, baseBudget: 2000n });
    expect([...c.kinds]).toEqual(['reopen', 'recurring', 'tender']);
    expect(c.dryRun).toBe(false);
  });
  it('names what is missing or wrong', () => {
    expect(() => loadConfig({ ...base, API_URL: '' })).toThrow(/API_URL is required/);
    expect(() => loadConfig({ ...base, MM_QUOTE_BUDGET: '1.5' })).toThrow(/MM_QUOTE_BUDGET/);
    expect(() => loadConfig({ ...base, MM_LEVELS: '99' })).toThrow(/MM_LEVELS/);
    expect(() => loadConfig({ ...base, MM_KINDS: 'reopen,bogus' })).toThrow(/bogus/);
    expect(() => loadConfig({ ...base, MM_CREATORS: 'nope' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MM_FAIR_VALUES: 'abc=1' })).toThrow(/MM_FAIR_VALUES/);
  });
  it('will not run on mainnet without the written confirmation', () => {
    expect(() => loadConfig({ ...base, NETWORK: 'mainnet-beta' })).toThrow(/refusing to run on mainnet-beta/);
    expect(loadConfig({ ...base, NETWORK: 'mainnet-beta', MM_ALLOW_MAINNET: 'yes-i-understand-this-spends-real-money' }).cluster).toBe('mainnet-beta');
  });
});

// ---------------------------------------------------------------------------------------------------------------- the loop

const OWNER = '11111111111111111111111111111112';
const BASE = 'BaseMint1111111111111111111111111111111111';
const QUOTE = 'QuoteMint111111111111111111111111111111111';
const NOW = 1_800_000_000n;
const SC = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function detail(over: Partial<CrossDetail> = {}): CrossDetail {
  return {
    address: 'CrossA', state: 'Live', disclosure: 'open', kind: 'reopen', supplyMode: 'escrow', creator: 'Creator1', baseMint: BASE, quoteMint: QUOTE,
    window: { openTs: String(NOW - 100n), closeTs: String(NOW + 600n), revealEndTs: String(NOW + 600n) },
    grid: { minPrice: '1000000', tick: '50000', ticks: 41, priceScale: '1000000' }, decimals: { base: 6, quote: 6 },
    fees: { protocolBps: 5, integratorBps: 20, integrator: 'I' }, orders: { total: 0, open: 0, max: 100 }, clearing: null, noPrintReason: null, gateMint: null,
    oracleGuard: false, settlement: { settleDeadlineTs: String(NOW + 1000n), baseBound: true }, ...over,
  };
}
const summary = (over: Partial<CrossSummary> = {}): CrossSummary => ({ address: 'CrossA', state: 'Live', creator: 'Creator1', base_mint: BASE, quote_mint: QUOTE, open_ts: String(NOW - 100n), close_ts: String(NOW + 600n), reveal_end_ts: String(NOW + 600n), clearing_price: null, matched: null, orders_committed: 0, ...over });

class Fake {
  crosses = new Map<string, { sum: CrossSummary; det: CrossDetail }>();
  finalized: CrossSummary[] = [];
  mine: OwnerOrder[] = [];
  open: OrderLookup[] = [];
  book: BookResponse = { disclosure: 'open', levels: [], indicative: null, note: '' };
  placed: { cross: string; nonce: bigint; side: string; price: bigint; quantity: bigint; salt?: Uint8Array }[] = [];
  revealed: { nonce: bigint; salt: Uint8Array }[] = [];
  claimed: { cross: string; nonce: bigint }[] = [];
  sent: string[] = [];
  balances = new Map<string, bigint>([[QUOTE, 10_000_000_000n], [BASE, 10_000_000_000n]]);
  logs: Record<string, unknown>[] = [];
  now = NOW;
  add(over: Partial<CrossDetail> = {}, sum: Partial<CrossSummary> = {}) {
    const address = (over.address as string) ?? 'CrossA';
    this.crosses.set(address, { sum: summary({ address, ...sum }), det: detail({ address, ...over }) });
  }
  api: BotApi = {
    listCrosses: async (o) => (o.state === 'Finalized' ? this.finalized : [...this.crosses.values()].filter((c) => !o.state || c.sum.state === o.state).map((c) => c.sum)),
    getCross: async (a) => this.crosses.get(a)!.det,
    getBook: async () => this.book,
    ownerOrders: async () => this.mine,
    orders: async (a) => a.map((x) => this.open.find((l) => l.address === x) ?? { address: x, found: false as const }),
    placeOrder: async (b) => (this.placed.push(b), { transactions: [{ transaction: 'AA==', signers: [] }], extra: {} } as BuiltAction),
    reveal: async (b) => (this.revealed.push({ nonce: b.nonce, salt: b.salt }), { transactions: [{ transaction: 'AA==', signers: [] }], extra: {} } as BuiltAction),
    claim: async (b) => (this.claimed.push(b), { transactions: [{ transaction: 'AA==', signers: [] }], extra: {} } as BuiltAction),
  };
  chain: BotChain = {
    unixTime: async () => this.now,
    balance: async (_o, mint) => this.balances.get(mint) ?? 10_000_000_000n,
    send: async (_t, label) => (this.sent.push(label), ['sig']),
  };
  store = { s: emptyState() as BotState, load: () => structuredClone(this.store.s), save: (s: BotState) => void (this.store.s = structuredClone(s)) };
  bot(over: Record<string, unknown> = {}, secret: Uint8Array | null = null) {
    return new MarketMaker({
      cfg: { strategy: S, creators: new Set(), kinds: new Set(['reopen', 'recurring', 'tender']), fairValues: new Map([[BASE, '1.5']]), maxOpenCrosses: 3, dryRun: false, ...over } as never,
      owner: OWNER, api: this.api, chain: this.chain, sealSecret: secret, store: this.store, log: (e) => void this.logs.push(e), random: () => 7n,
    });
  }
}

describe('market maker pass', () => {
  it('quotes a two-sided ladder into an open reopen cross from the configured fair value and remembers it', async () => {
    const f = new Fake();
    f.add();
    const r = await f.bot().pass();
    expect(r).toMatchObject({ placed: 2, errors: 0 });
    expect(f.placed.map((p) => [p.side, p.price, p.nonce])).toEqual([['buy', 1_450_000n, 1792n], ['sell', 1_550_000n, 1793n]]);
    expect(f.placed.every((p) => p.salt === undefined)).toBe(true);
    expect(f.store.s.crosses.CrossA!.orders).toHaveLength(2);
    expect(f.logs.find((l) => l.event === 'quote')).toMatchObject({ reference: { source: 'configured' } });
  });

  it('does not quote twice into a cross it already has orders in', async () => {
    const f = new Fake();
    f.add();
    f.mine = [{ cross_address: 'CrossA', idx: 0, address: 'o0', side: 'buy', escrow: '1', sealed: false, price: '1450000', quantity: '10', status: 'revealed', fill: null, quote_out: null, base_out: null, fee: null }];
    await f.bot().pass();
    expect(f.placed).toEqual([]);
  });

  it('leaves alone what it must: launches, gated crosses, other creators, closing crosses, crosses without a reference', async () => {
    const f = new Fake();
    f.add({ address: 'Launch', kind: 'launch' });
    f.add({ address: 'Gated', gateMint: 'G' });
    f.add({ address: 'Foreign', creator: 'Someone' }, { creator: 'Someone' });
    f.add({ address: 'Closing', window: { openTs: String(NOW - 100n), closeTs: String(NOW + 10n), revealEndTs: String(NOW + 10n) } }, { close_ts: String(NOW + 10n) });
    f.add({ address: 'Unpriced', baseMint: 'OtherBase' });
    f.add({ address: 'Upcoming', window: { openTs: String(NOW + 50n), closeTs: String(NOW + 600n), revealEndTs: String(NOW + 600n) } });
    const r = await f.bot({ creators: new Set(['Creator1']) }).pass();
    expect(r.placed).toBe(0);
    expect(r.skipped).toMatchObject({
      'kind "launch" is not quoted': 1, 'is gated: the bot holds no pass': 1, 'creator is not on the allow list': 1, 'closes too soon': 1, 'has not opened yet': 1,
    });
    expect(Object.keys(r.skipped).some((k) => k.startsWith('no reference price'))).toBe(true);
  });

  it('uses the last print of the pair, then the book, and quotes nothing when neither exists', async () => {
    const f = new Fake();
    f.add({ address: 'NoFair', baseMint: 'OtherBase' });
    f.finalized = [summary({ address: 'Old', state: 'Finalized', base_mint: 'OtherBase', clearing_price: '2000000' })];
    await f.bot().pass();
    expect(f.placed.map((p) => p.price)).toEqual([1_950_000n, 1_900_000n, 2_050_000n, 2_100_000n]);
    expect(f.logs.find((l) => l.event === 'quote')).toMatchObject({ reference: { source: 'last-print', price: '2000000' } });

    const g = new Fake();
    g.add({ address: 'Book', baseMint: 'OtherBase' });
    g.book = { disclosure: 'open', levels: [], indicative: { price: '1800000', matched: '1' }, note: '' };
    await g.bot().pass();
    expect(g.logs.find((l) => l.event === 'quote')).toMatchObject({ reference: { source: 'indicative' } });
  });

  it('does not place a mint-mode cross\'s asks and respects the number of crosses it may hold', async () => {
    const f = new Fake();
    f.add({ address: 'M1', supplyMode: 'mint' });
    f.add({ address: 'M2', supplyMode: 'escrow' });
    f.add({ address: 'M3', supplyMode: 'escrow' });
    f.add({ address: 'M4', supplyMode: 'escrow' });
    const r = await f.bot({ maxOpenCrosses: 2 }).pass();
    expect(r.placed).toBe(1 + 2); // M1 bids only, M2 bids and asks, then the limit is reached
    expect(f.placed.filter((p) => p.cross === 'M1').map((p) => p.side)).toEqual(['buy']);
  });

  it('seals orders with salts derived from the secret and reveals them from the state', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const f = new Fake();
    f.add({ address: SC, disclosure: 'sealed' });
    await f.bot({}, secret).pass();
    const buy = f.placed[0]!;
    expect(buy.salt).toEqual(deriveSalt(secret, SC, OWNER, buy.nonce));

    // The window passes into the reveal phase; the index shows the orders as committed and the chain as open and hidden.
    f.crosses.set(SC, { sum: summary({ address: SC }), det: detail({ address: SC, disclosure: 'sealed', window: { openTs: String(NOW - 700n), closeTs: String(NOW - 10n), revealEndTs: String(NOW + 300n) } }) });
    f.mine = f.store.s.crosses[SC]!.orders.map((o, i) => ({ cross_address: SC, idx: i, address: `o${i}`, side: o.side, escrow: '1', sealed: true, price: null, quantity: null, status: 'committed' as const, fill: null, quote_out: null, base_out: null, fee: null }));
    f.open = f.store.s.crosses[SC]!.orders.map((o, i) => ({ address: `o${i}`, found: true as const, open: true as const, cross: SC, owner: OWNER, nonce: o.nonce, index: i, side: o.side, revealed: false, escrow: '1' }));
    const r = await f.bot({}, secret).pass();
    expect(r.revealed).toBe(2);
    expect(f.revealed.map((x) => x.nonce)).toEqual(f.placed.map((p) => p.nonce));
    expect(f.revealed[0]!.salt).toEqual(buy.salt);
  });

  it('skips a sealed cross when no secret is configured', async () => {
    const f = new Fake();
    f.add({ disclosure: 'sealed' });
    const r = await f.bot().pass();
    expect(r.placed).toBe(0);
    expect(r.skipped).toEqual({ 'is sealed and no seal secret is configured': 1 });
  });

  it('claims every order still open on chain once the cross has printed, and none that are already closed', async () => {
    const f = new Fake();
    f.add({ state: 'Cleared' }, { state: 'Cleared' });
    f.mine = ['o0', 'o1'].map((a, i) => ({ cross_address: 'CrossA', idx: i, address: a, side: 'buy' as const, escrow: '1', sealed: false, price: '1', quantity: '1', status: 'revealed' as const, fill: null, quote_out: null, base_out: null, fee: null }));
    f.open = [{ address: 'o0', found: true, open: true, cross: 'CrossA', owner: OWNER, nonce: '1792', index: 0, side: 'buy', revealed: true, escrow: '1' }, { address: 'o1', found: true, open: false, cross: 'CrossA', side: 'buy', idx: 1, escrow: '1', sealed: false, price: '1', quantity: '1', status: 'claimed', fill: '1', quote_out: '0', base_out: '1', fee: '0' } as never];
    const r = await f.bot().pass();
    expect(r.claimed).toBe(1);
    expect(f.claimed).toEqual([{ cross: 'CrossA', owner: OWNER, nonce: 1792n }]);
  });

  it('keeps going when one cross fails and reports the error', async () => {
    const f = new Fake();
    f.add({ address: 'Bad' });
    f.add({ address: 'Good' });
    const real = f.api.getCross;
    f.api.getCross = async (a) => {
      if (a === 'Bad') throw new Error('the API did not answer');
      return real(a);
    };
    const r = await f.bot().pass();
    expect(r.errors).toBe(1);
    expect(f.placed.some((p) => p.cross === 'Good')).toBe(true);
    expect(f.logs.find((l) => l.event === 'error')).toMatchObject({ cross: 'Bad', message: 'the API did not answer' });
  });

  it('in dry-run builds the transactions but remembers nothing', async () => {
    const f = new Fake();
    f.add();
    await f.bot({ dryRun: true }).pass();
    expect(f.placed).toHaveLength(2);
    expect(f.store.s.crosses).toEqual({});
  });

  it('reports its own volume from the index, apart from anyone else', async () => {
    const f = new Fake();
    f.mine = [
      { cross_address: 'A', idx: 0, address: 'a', side: 'buy', escrow: '1', sealed: false, price: '1', quantity: '1', status: 'claimed', fill: '5', quote_out: '10', base_out: '5', fee: '1' },
      { cross_address: 'A', idx: 1, address: 'b', side: 'sell', escrow: '1', sealed: false, price: '1', quantity: '1', status: 'claimed', fill: null, quote_out: null, base_out: null, fee: null },
    ];
    expect(await f.bot().volume()).toEqual({ orders: 2, filled: 1, quoteOut: 10n, baseOut: 5n, fees: 1n });
  });
});
