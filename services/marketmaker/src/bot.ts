// The market-maker bot's loop. One pass:
//   1. finds the Live crosses it may quote into and, for each it has no orders in, places a two-sided ladder around a
//      reference price from its own budget;
//   2. reveals its sealed orders in the reveal window;
//   3. claims fills and refunds from every cross that has printed or failed to print.
// Every action is a transaction built by the Opening Cross API, signed here with the bot's own key and sent by the client
// pipeline. A failure in one cross is logged and never stops the others. Nothing is retried blindly: a placement that
// half-landed is seen again on the next pass through the orders the index holds for this wallet.
import { type ActionError, type BookResponse, type BuiltAction, type CrossDetail, type CrossSummary, type OrderLookup, type OwnerOrder, type UnsignedTransaction, phaseOf, parsePrice, marketOf } from '@opening-cross/client';
import { type Grid, deriveSalt, planOrders } from '@opening-cross/liquidity';
import { type CrossKind, type MmConfig } from './config.js';
import { buildQuote, chooseReference } from './strategy.js';

export interface BotApi {
  listCrosses(o: { state?: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized'; limit?: number }): Promise<CrossSummary[]>;
  getCross(address: string): Promise<CrossDetail>;
  getBook(address: string): Promise<BookResponse>;
  ownerOrders(owner: string): Promise<OwnerOrder[]>;
  orders(addresses: readonly string[]): Promise<OrderLookup[]>;
  placeOrder(b: { cross: string; owner: string; nonce: bigint; side: 'buy' | 'sell'; price: bigint; quantity: bigint; salt?: Uint8Array }): Promise<BuiltAction>;
  reveal(b: { cross: string; owner: string; nonce: bigint; price: bigint; quantity: bigint; salt: Uint8Array }): Promise<BuiltAction>;
  claim(b: { cross: string; owner: string; nonce: bigint }): Promise<BuiltAction>;
}

export interface BotChain {
  /** The cluster's clock in unix seconds. */
  unixTime(): Promise<bigint>;
  /** Balance in atoms of `mint` held by `owner` in its associated token account; 0 when there is none. */
  balance(owner: string, mint: string): Promise<bigint>;
  /** Signs, sends and confirms the transactions in order and returns their signatures. In dry-run it simulates them and returns []. */
  send(txs: readonly UnsignedTransaction[], label: string): Promise<string[]>;
}

export type PlacedOrder = { nonce: string; side: 'buy' | 'sell'; price: string; quantity: string };
export type BotState = { version: 1; crosses: Record<string, { placedAt: number; sealed: boolean; orders: PlacedOrder[] }> };
export const emptyState = (): BotState => ({ version: 1, crosses: {} });

export interface StateStore {
  load(): BotState;
  save(s: BotState): void;
}

export type BotDeps = {
  cfg: Pick<MmConfig, 'strategy' | 'creators' | 'kinds' | 'fairValues' | 'maxOpenCrosses' | 'dryRun'>;
  owner: string;
  api: BotApi;
  chain: BotChain;
  /** 32+ bytes; null means sealed crosses are skipped. */
  sealSecret: Uint8Array | null;
  store: StateStore;
  log: (event: Record<string, unknown>) => void;
  /** Random 40-bit prefix source; the order nonces are prefix * 256 + k so a pass owns a contiguous run. */
  random?: () => bigint;
};

export type PassSummary = { placed: number; revealed: number; claimed: number; skipped: Record<string, number>; errors: number };

const msg = (e: unknown): string => (e as ActionError | Error)?.message ?? String(e);

export class MarketMaker {
  private readonly d: BotDeps;
  private skippedLogged = new Set<string>();

  constructor(d: BotDeps) {
    this.d = d;
  }

  private note(skipped: Record<string, number>, cross: string, reason: string) {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    // One log line per cross and reason, not one per pass.
    const key = `${cross}|${reason}`;
    if (!this.skippedLogged.has(key)) {
      this.skippedLogged.add(key);
      this.d.log({ event: 'skip', cross, reason });
    }
  }

  async pass(): Promise<PassSummary> {
    const { api, chain, owner, log } = this.d;
    const out: PassSummary = { placed: 0, revealed: 0, claimed: 0, skipped: {}, errors: 0 };
    const state = this.d.store.load();
    const now = await chain.unixTime();
    const mine = await api.ownerOrders(owner);
    const mineByCross = new Map<string, OwnerOrder[]>();
    for (const o of mine) mineByCross.set(o.cross_address, [...(mineByCross.get(o.cross_address) ?? []), o]);

    // ---- 3 and 2 first: money owed and reveals due outrank new quotes.
    for (const [cross, orders] of mineByCross) {
      try {
        const detail = await api.getCross(cross);
        const phase = phaseOf(detail, now);
        if (phase === 'reveal') out.revealed += await this.reveal(cross, detail, orders, state);
        else if (detail.state !== 'Live') out.claimed += await this.claim(cross, orders);
      } catch (e) {
        out.errors++;
        log({ event: 'error', where: 'settle-own', cross, message: msg(e) });
      }
    }

    // ---- 1: new quotes.
    const open = [...mineByCross.keys()].filter((c) => state.crosses[c] && !mineByCross.get(c)!.every((o) => o.status === 'claimed' || o.status === 'cancelled')).length;
    let room = this.d.cfg.maxOpenCrosses - open;
    if (room > 0) {
      const live = await api.listCrosses({ state: 'Live', limit: 100 });
      for (const c of live) {
        if (room <= 0) break;
        if (mineByCross.has(c.address)) continue;
        try {
          if (await this.quote(c, now, state, out)) room--;
        } catch (e) {
          out.errors++;
          log({ event: 'error', where: 'quote', cross: c.address, message: msg(e) });
        }
      }
    }
    this.d.store.save(state);
    log({ event: 'pass', ...out });
    return out;
  }

  private async quote(c: CrossSummary, now: bigint, state: BotState, out: PassSummary): Promise<boolean> {
    const { api, chain, owner, cfg, log } = this.d;
    if (cfg.creators.size > 0 && !cfg.creators.has(c.creator)) {
      this.note(out.skipped, c.address, 'creator is not on the allow list');
      return false;
    }
    if (BigInt(c.close_ts) <= now) return false; // closed and waiting for the keeper: not a decision worth logging
    const detail = await api.getCross(c.address);
    const phase = phaseOf(detail, now);
    if (phase !== 'open') {
      this.note(out.skipped, c.address, phase === 'upcoming' ? 'has not opened yet' : `is in the ${phase} phase`);
      return false;
    }
    if (BigInt(detail.window.closeTs) - now < BigInt(cfg.strategy.minSecondsLeft)) {
      this.note(out.skipped, c.address, 'closes too soon');
      return false;
    }
    if (!cfg.kinds.has(detail.kind as CrossKind)) {
      this.note(out.skipped, c.address, `kind "${detail.kind}" is not quoted`);
      return false;
    }
    if (detail.gateMint) {
      this.note(out.skipped, c.address, 'is gated: the bot holds no pass');
      return false;
    }
    const sealed = detail.disclosure === 'sealed';
    if (sealed && !this.d.sealSecret) {
      this.note(out.skipped, c.address, 'is sealed and no seal secret is configured');
      return false;
    }
    if (!detail.baseMint) {
      this.note(out.skipped, c.address, 'has no base mint bound yet');
      return false;
    }

    const grid: Grid = { minPrice: BigInt(detail.grid.minPrice), tick: BigInt(detail.grid.tick), ticks: detail.grid.ticks, priceScale: BigInt(detail.grid.priceScale) };
    const market = marketOf(detail);
    const configuredText = cfg.fairValues.get(detail.baseMint);
    const configured = configuredText === undefined ? null : parsePrice(configuredText, market);
    if (configuredText !== undefined && configured === null) {
      this.note(out.skipped, c.address, `the configured fair value ${configuredText} is not representable on this cross's price scale`);
      return false;
    }
    const finalized = await api.listCrosses({ state: 'Finalized', limit: 100 });
    const prior = finalized.find((f) => f.base_mint === detail.baseMint && f.quote_mint === detail.quoteMint && f.clearing_price !== null);
    const book = configured === null && !prior ? await api.getBook(c.address) : null;
    const ref = chooseReference({
      configured,
      lastPrint: prior ? { price: BigInt(prior.clearing_price!), cross: prior.address } : null,
      indicative: book?.indicative ? BigInt(book.indicative.price) : null,
    });
    if (!ref) {
      this.note(out.skipped, c.address, 'no reference price: nothing configured, no earlier print of this pair, and the book does not cross');
      return false;
    }

    const [quoteBal, baseBal] = await Promise.all([chain.balance(owner, detail.quoteMint), chain.balance(owner, detail.baseMint)]);
    const sells = detail.supplyMode === 'escrow';
    const plan = buildQuote(ref.price, cfg.strategy, grid, { quote: quoteBal, base: baseBal }, sells);
    if (plan.kind === 'skip') {
      this.note(out.skipped, c.address, plan.reason);
      return false;
    }

    const prefix = (this.d.random?.() ?? BigInt(Math.floor(Math.random() * 2 ** 40))) & ((1n << 40n) - 1n);
    const first = prefix * 256n;
    const orders = planOrders({ cross: c.address, owner, ladder: plan.ladder, firstNonce: first, ...(sealed ? { master: this.d.sealSecret! } : {}) });
    log({ event: 'quote', cross: c.address, reference: { price: ref.price.toString(), source: ref.source, detail: ref.detail }, escrow: { quote: plan.escrow.quote.toString(), base: plan.escrow.base.toString() }, orders: orders.length, notes: plan.notes, dryRun: cfg.dryRun });

    const placed: PlacedOrder[] = [];
    state.crosses[c.address] = { placedAt: Number(now), sealed, orders: placed };
    for (const o of orders) {
      const built = await api.placeOrder({ cross: c.address, owner, nonce: o.nonce, side: o.side, price: o.price, quantity: o.quantity, ...(o.salt ? { salt: o.salt } : {}) });
      const sigs = await chain.send(built.transactions, `place ${o.side} ${o.quantity}@${o.price}`);
      placed.push({ nonce: o.nonce.toString(), side: o.side, price: o.price.toString(), quantity: o.quantity.toString() });
      log({ event: 'placed', cross: c.address, side: o.side, price: o.price.toString(), quantity: o.quantity.toString(), nonce: o.nonce.toString(), signatures: sigs });
      out.placed++;
    }
    if (cfg.dryRun) delete state.crosses[c.address];
    return true;
  }

  /** Reveals the sealed orders of `cross` that are still hidden. The salt of each is derived from the seal secret; price and size come from the state. */
  private async reveal(cross: string, detail: CrossDetail, orders: OwnerOrder[], state: BotState): Promise<number> {
    const { api, chain, owner, log } = this.d;
    const placed = state.crosses[cross];
    if (!placed || !placed.sealed || !this.d.sealSecret) return 0;
    const hidden = orders.filter((o) => o.status === 'committed');
    if (hidden.length === 0) return 0;
    const lookups = await api.orders(hidden.map((o) => o.address));
    let n = 0;
    for (const l of lookups) {
      if (!l.found || !l.open || l.revealed) continue;
      const mine = placed.orders.find((p) => p.nonce === l.nonce);
      if (!mine) {
        log({ event: 'reveal-unresolved', cross, order: l.address, reason: 'the order is not in the bot state, so its price and size are unknown' });
        continue;
      }
      const salt = deriveSalt(this.d.sealSecret, cross, owner, BigInt(mine.nonce));
      const built = await api.reveal({ cross, owner, nonce: BigInt(mine.nonce), price: BigInt(mine.price), quantity: BigInt(mine.quantity), salt });
      const sigs = await chain.send(built.transactions, `reveal ${mine.nonce}`);
      log({ event: 'revealed', cross, nonce: mine.nonce, signatures: sigs, window: detail.window });
      n++;
    }
    return n;
  }

  /** Claims every order of `cross` that is still open on chain: the fill and the refund, or the full refund if the cross did not print. */
  private async claim(cross: string, orders: OwnerOrder[]): Promise<number> {
    const { api, chain, owner, log } = this.d;
    const pending = orders.filter((o) => o.status === 'committed' || o.status === 'revealed');
    if (pending.length === 0) return 0;
    // `GET /v1/orders` reads open orders from chain, with their nonce; an order that is no longer open has been claimed.
    const lookups = await api.orders(pending.map((o) => o.address));
    let n = 0;
    for (const l of lookups) {
      if (!l.found || !l.open) continue;
      const built = await api.claim({ cross, owner, nonce: BigInt(l.nonce) });
      const sigs = await chain.send(built.transactions, `claim ${l.nonce}`);
      log({ event: 'claimed', cross, nonce: l.nonce, signatures: sigs });
      n++;
    }
    return n;
  }

  /** The bot's own volume, from the orders the index holds for its wallet: reported apart from outside users (Y7). */
  async volume(): Promise<{ orders: number; filled: number; quoteOut: bigint; baseOut: bigint; fees: bigint }> {
    const orders = await this.d.api.ownerOrders(this.d.owner);
    let filled = 0;
    let quoteOut = 0n;
    let baseOut = 0n;
    let fees = 0n;
    for (const o of orders) {
      if (o.fill && BigInt(o.fill) > 0n) filled++;
      quoteOut += BigInt(o.quote_out ?? '0');
      baseOut += BigInt(o.base_out ?? '0');
      fees += BigInt(o.fee ?? '0');
    }
    return { orders: orders.length, filled, quoteOut, baseOut, fees };
  }
}
