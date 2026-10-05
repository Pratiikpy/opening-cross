// A ready-made protocol deployment inside LiteSVM, plus helpers to drive a cross end to end
// through the SDK exactly as a client would.
import type { Address, KeyPairSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  Disclosure,
  type CrossView,
  OrderSide,
  SupplyMode,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  crossAddress,
  getCrossDecoder,
  getInitProtocolInstruction,
  getOrderDecoder,
  orderAddress,
  protocolAddress,
} from '@opening-cross/sdk';
import { Harness, T0, salt } from './harness.js';

export const FEES: [number, number, number, number] = [30, 5, 15, 30];
export const SCALE = 1_000_000n; // prices are quote atoms per 1 whole base token (6 decimals)

export type CrossOptions = {
  kind?: CrossKind;
  supplyMode?: SupplyMode;
  disclosure?: Disclosure;
  minPrice?: bigint;
  tick?: bigint;
  ticks?: number;
  shards?: number;
  maxOrders?: number;
  minMatched?: bigint;
  maxImbalanceBps?: number | null;
  reference?: bigint | null;
  integratorFeeBps?: number;
  gateMint?: Address | null;
  schedule?: { price: bigint; quantity: bigint }[];
  settler?: Address | null;
  oracle?: { feedId: Uint8Array; maxDivergenceBps: number; maxStalenessSecs: number } | null;
  settleDeadlineTs?: bigint;
};

export type PlacedOrder = {
  owner: KeyPairSigner;
  nonce: bigint;
  side: OrderSide;
  price: bigint;
  quantity: bigint;
  escrow: bigint;
  index: number;
  salt: Uint8Array;
  reveal: boolean;
};

export class World {
  readonly h = new Harness();
  admin!: KeyPairSigner;
  guardian!: KeyPairSigner;
  feeRecipient!: KeyPairSigner;
  integrator!: KeyPairSigner;
  creator!: KeyPairSigner;
  quoteMint!: Address;
  baseMint!: Address;
  private nextId = 1n;

  static async create(): Promise<World> {
    const w = new World();
    w.admin = await w.h.wallet();
    w.guardian = await w.h.wallet();
    w.feeRecipient = await w.h.wallet();
    w.integrator = await w.h.wallet();
    w.creator = await w.h.wallet(100n);
    await w.h.send([getInitProtocolInstruction({ admin: w.admin, protocol: await protocolAddress(), guardian: w.guardian.address, feeRecipient: w.feeRecipient.address, feeBps: FEES })], w.admin);
    w.quoteMint = await w.h.mint(w.admin, 6);
    w.baseMint = await w.h.mint(w.admin, 6);
    for (const who of [w.feeRecipient, w.integrator, w.creator]) {
      await w.h.ata(who.address, w.quoteMint, w.admin);
      await w.h.ata(who.address, w.baseMint, w.admin);
    }
    await w.h.fund(w.quoteMint, w.admin, w.creator.address, 1_000_000_000_000n);
    return w;
  }

  async newCross(o: CrossOptions = {}): Promise<CrossView> {
    const crossId = this.nextId++;
    const supplyMode = o.supplyMode ?? SupplyMode.Escrow;
    let baseMint: Address | undefined = this.baseMint;
    if (supplyMode === SupplyMode.DeferredMint) baseMint = undefined;
    if (supplyMode === SupplyMode.Mint) {
      baseMint = await this.h.mint(this.admin, 6);
      await this.h.ata(this.creator.address, baseMint, this.admin);
      await this.h.setMintAuthority(baseMint, this.admin, await crossAddress(this.creator.address, crossId));
    }
    const { cross, create, shards } = await buildCreateCross({
      creator: this.creator,
      ...(baseMint ? { baseMint } : {}),
      quoteMint: this.quoteMint,
      baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId,
      kind: o.kind ?? CrossKind.Launch,
      supplyMode,
      disclosure: o.disclosure ?? Disclosure.Open,
      minPrice: o.minPrice ?? 1_000_000n,
      tick: o.tick ?? 100_000n,
      ticks: o.ticks ?? 20,
      priceScale: SCALE,
      openTs: T0,
      closeTs: T0 + 100n,
      revealEndTs: T0 + 200n,
      referencePrice: o.reference ?? null,
      minMatched: o.minMatched ?? 0n,
      maxImbalanceBps: o.maxImbalanceBps ?? null,
      integratorFeeBps: o.integratorFeeBps ?? 20,
      integrator: this.integrator.address,
      gateMint: o.gateMint ?? null,
      shards: o.shards ?? 2,
      maxOrders: o.maxOrders ?? 64,
      proceedsTo: this.creator.address,
      schedule: o.schedule ?? [],
      oracle: o.oracle ?? null,
      settler: o.settler ?? null,
      settleDeadlineTs: o.settleDeadlineTs ?? 0n,
    });
    await this.h.send([create], this.creator);
    for (const s of shards) await this.h.send([s], this.creator);
    this.h.setTime(T0);
    return this.view(cross);
  }

  view(cross: Address): CrossView {
    const a = this.h.svm.getAccount(cross);
    if (!a.exists) throw new Error('cross missing');
    return { address: cross, data: getCrossDecoder().decode(a.data) };
  }

  async trader(quote = 0n, base = 0n): Promise<KeyPairSigner> {
    const t = await this.h.wallet();
    await this.h.fund(this.quoteMint, this.admin, t.address, quote);
    await this.h.fund(this.baseMint, this.admin, t.address, base);
    return t;
  }

  async place(cross: CrossView, owner: KeyPairSigner, side: OrderSide, price: bigint, quantity: bigint, opts: { escrow?: bigint; reveal?: boolean; nonce?: bigint } = {}): Promise<PlacedOrder> {
    const view = this.view(cross.address);
    const nonce = opts.nonce ?? BigInt(view.data.ordersTotal);
    const s = salt();
    const ix = await buildPlaceOrder({ cross: view, owner, nonce, side, price, quantity, salt: s, ...(opts.escrow !== undefined ? { escrow: opts.escrow } : {}) });
    await this.h.send([ix], owner);
    const order = this.h.svm.getAccount(await orderAddress(cross.address, owner.address, nonce));
    if (!order.exists) throw new Error('order missing');
    const decoded = getOrderDecoder().decode(order.data);
    return { owner, nonce, side, price, quantity, escrow: decoded.escrow, index: decoded.index, salt: s, reveal: opts.reveal ?? true };
  }

  async revealAll(cross: CrossView, orders: PlacedOrder[]): Promise<void> {
    this.h.setTime(cross.data.closeTs + 1n);
    for (const o of orders.filter((x) => x.reveal)) {
      await this.h.send([await buildReveal(this.view(cross.address), o.owner, o.nonce, o.index, o.price, o.quantity, o.salt)], o.owner);
    }
  }

  async settle(cross: CrossView, oraclePrice?: Address): Promise<CrossView> {
    this.h.setTime(cross.data.revealEndTs + 1n);
    for (const ix of await buildSettleBook(this.view(cross.address), oraclePrice ? { oraclePrice } : {})) await this.h.send([ix], this.admin);
    return this.view(cross.address);
  }

  async claimAll(cross: CrossView, orders: PlacedOrder[], cranker: KeyPairSigner = this.admin): Promise<void> {
    for (const o of orders) {
      await this.h.send(await buildClaim(this.view(cross.address), cranker, o.owner.address, o.nonce), cranker);
    }
  }

  async finalize(cross: CrossView): Promise<CrossView> {
    await this.h.send([await buildFinalize(this.view(cross.address), this.admin)], this.admin);
    return this.view(cross.address);
  }

  async cancel(cross: CrossView, o: PlacedOrder): Promise<void> {
    const v = this.view(cross.address);
    await this.h.send([await buildCancel(v, o.owner, o.nonce, o.side, o.index, v.data.disclosure === Disclosure.Open)], o.owner);
  }
}

export { CROSS_CORE_PROGRAM_ADDRESS };
