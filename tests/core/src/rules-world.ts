// A cross world for crosses that carry rules (ADR-0450 to ADR-0459): the same protocol deployment as `World`, with the
// builders that add the accounts a rule-bearing cross calls for (remaining accounts, in the order the program defines)
// and the shard an order belongs to when the call has an ending period. Production tooling does the same; these
// builders are the reference for it.
import { type Address, type Instruction, type KeyPairSigner, type TransactionSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import {
  AUX_END_BASE,
  AUX_EXT_BASE,
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  type CrossExt,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_GUARD_SCALED_UI,
  FLAG_RESUMES_HALT,
  type OrderExt,
  OrderSide,
  SLOT_HASHES,
  SupplyMode,
  type CrossView,
  type RulesConfig,
  applicantAddress,
  ata,
  auxBit,
  auxShardIndexes,
  auxShardIndexesFor,
  baseVaultAddress,
  bookAddress,
  cancelExtras,
  claimExtras,
  classBookAddress,
  clearExtras,
  commitExtras,
  completeRules,
  costCeil,
  crossAddress,
  gatePassAddress,
  getCancelOrderInstruction,
  getClaimInstruction,
  getClearInstruction,
  getCommitOrderExtInstruction,
  getCommitOrderInstruction,
  getCrossDecoder,
  getDrawBeginInstruction,
  getDrawFinishInstruction,
  getFinalizeInstruction,
  getInitClassBookInstruction,
  getInitLockVaultInstruction,
  getInitProtocolInstruction,
  getInitShardInstruction,
  getMergeShardInstruction,
  getOrderDecoder,
  getPushRefundsInstruction,
  getReleaseLockedInstruction,
  getRevealOrderInstruction,
  getSetRulesInstruction,
  hasFlag,
  lastBucket,
  lockVaultAddress,
  lockupAddress,
  orderAddress,
  orderCommitment,
  orderPda,
  placementAt,
  printFeedAddress,
  protocolAddress,
  quoteVaultAddress,
  readCrossExt,
  readOrderExt,
  readonly,
  revealExtras,
  shardAddress,
  shardIndexFor,
  usesLocks,
  usesClassBook,
  withAccounts,
  writable,
} from '@opening-cross/sdk';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { T0, salt } from './harness.js';
import { FEES, SCALE, World, type CrossOptions, type PlacedOrder } from './world.js';

export type RView = CrossView & { ext: CrossExt | null };

export type RuledOptions = CrossOptions & {
  rules?: RulesConfig;
  /** Where `finalize` pays the proceeds. Defaults to the creator. */
  proceedsTo?: Address;
  /** Mint mode: base atoms minted to the creator before the mint authority passes to the cross. */
  premintBase?: bigint;
  /** Lender print feed, for rules that set FEEDS_LENDERS. Defaults to the feed of the base mint. */
  feed?: Address;
  /** Extra accounts appended to `set_rules` (a bond: creator quote, quote vault, mint, program). */
  rulesExtra?: Parameters<typeof withAccounts>[1];
  /** Send `set_rules` in its own transaction this many slots after `create` instead of in the same one (to test the slot rule). */
  rulesAfterSlots?: bigint;
};

export type RuledPlace = {
  escrow?: bigint;
  reveal?: boolean;
  nonce?: bigint;
  class?: number;
  lockSecs?: number;
};

export class RulesWorld extends World {
  static async createRules(): Promise<RulesWorld> {
    const w = new RulesWorld();
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

  override view(cross: Address): RView {
    const a = this.h.svm.getAccount(cross);
    if (!a.exists) throw new Error('cross missing');
    return { address: cross, data: getCrossDecoder().decode(a.data), ext: readCrossExt(a.data) };
  }

  /** The tail as stored, whether or not the rules were set. */
  rawExt(cross: Address) {
    const a = this.h.svm.getAccount(cross);
    if (!a.exists) throw new Error('cross missing');
    return a.data;
  }

  /** `create_cross` and, when rules are given, `set_rules` in the same transaction, then every account the rules call for. */
  async newRuledCross(o: RuledOptions = {}): Promise<RView> {
    const crossId = this.nextId++;
    this.h.setTime(o.openTs ?? T0);
    const supplyMode = o.supplyMode ?? SupplyMode.Escrow;
    let baseMint: Address | undefined = this.baseMint;
    if (supplyMode === SupplyMode.DeferredMint) baseMint = undefined;
    const crossKey = await crossAddress(this.creator.address, crossId);
    if (supplyMode === SupplyMode.Mint) {
      baseMint = await this.h.mint(this.admin, 6);
      await this.h.ata(this.creator.address, baseMint, this.admin);
      if (o.premintBase) await this.h.fund(baseMint, this.admin, this.creator.address, o.premintBase);
      await this.h.setMintAuthority(baseMint, this.admin, crossKey);
    }
    const { create, shards } = await this.buildCreate(crossId, crossKey, baseMint, o);
    const rulesIx = o.rules ? await this.buildSetRules(crossKey, baseMint, o) : undefined;
    if (rulesIx && o.rulesAfterSlots === undefined) await this.h.send([create, rulesIx], this.creator);
    else {
      await this.h.send([create], this.creator);
      if (rulesIx) {
        if (o.rulesAfterSlots) this.h.svm.warpToSlot(this.h.svm.getClock().slot + o.rulesAfterSlots);
        await this.h.send([rulesIx], this.creator);
      }
    }
    for (const s of shards) await this.h.send([s], this.creator);
    if (o.rules) {
      const full = completeRules(o.rules);
      for (const index of auxShardIndexesFor(full.ending, o.shards ?? 2)) {
        await this.h.send([getInitShardInstruction({ payer: this.creator, cross: crossKey, shard: await shardAddress(crossKey, index), index })], this.creator);
      }
      const classes = full.alloc.reserveBps.some((b) => b > 0) || full.alloc.lotteryUnit > 0n || full.neutrality.insiders.length > 0;
      if (classes) await this.h.send([getInitClassBookInstruction({ payer: this.creator, cross: crossKey, classBook: await classBookAddress(crossKey) })], this.creator);
      const locks = full.alloc.minLockSecs > 0 || full.alloc.class1CliffSecs > 0 || full.alloc.class1VestSecs > 0 || full.neutrality.insiderCliffSecs > 0 || full.neutrality.insiderVestSecs > 0;
      if (locks && baseMint) {
        await this.h.send([getInitLockVaultInstruction({ payer: this.creator, cross: crossKey, baseMint, lockVault: await lockVaultAddress(crossKey), baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], this.creator);
      }
    }
    this.h.setTime(o.openTs ?? T0);
    return this.view(crossKey);
  }

  private async buildCreate(crossId: bigint, cross: Address, baseMint: Address | undefined, o: RuledOptions) {
    const { buildCreateCross } = await import('@opening-cross/sdk');
    const built = await buildCreateCross({
      creator: this.creator,
      ...(baseMint ? { baseMint } : {}),
      quoteMint: this.quoteMint,
      baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId,
      kind: o.kind ?? CrossKind.Launch,
      supplyMode: o.supplyMode ?? SupplyMode.Escrow,
      disclosure: o.disclosure ?? Disclosure.Open,
      minPrice: o.minPrice ?? 1_000_000n,
      tick: o.tick ?? 100_000n,
      ticks: o.ticks ?? 20,
      priceScale: SCALE,
      openTs: o.openTs ?? T0,
      closeTs: o.closeTs ?? T0 + 100n,
      revealEndTs: (o.closeTs ?? T0 + 100n) + 100n,
      referencePrice: o.reference ?? null,
      minMatched: o.minMatched ?? 0n,
      maxImbalanceBps: o.maxImbalanceBps ?? null,
      integratorFeeBps: o.integratorFeeBps ?? 20,
      integrator: this.integrator.address,
      gateMint: o.gateMint ?? null,
      shards: o.shards ?? 2,
      maxOrders: o.maxOrders ?? 64,
      proceedsTo: o.proceedsTo ?? this.creator.address,
      schedule: o.schedule ?? [],
      oracle: o.oracle ?? null,
      calendar: o.calendar ?? null,
      settler: o.settler ?? null,
      settleDeadlineTs: o.settleDeadlineTs ?? 0n,
    });
    if (built.cross !== cross) throw new Error('cross address mismatch');
    return built;
  }

  private async buildSetRules(cross: Address, baseMint: Address | undefined, o: RuledOptions): Promise<Instruction> {
    const full = completeRules(o.rules);
    let ix = getSetRulesInstruction({ creator: this.creator, cross, ...full });
    const extra = [];
    const haltSource = full.guards.haltSource;
    if ((full.flags & FLAG_RESUMES_HALT) !== 0 && haltSource) extra.push(readonly(typeof haltSource === 'string' ? haltSource : haltSource.__option === 'Some' ? haltSource.value : (() => { throw new Error('no halt source'); })()));
    if ((full.flags & FLAG_FEEDS_LENDERS) !== 0) {
      if (!baseMint) throw new Error('a lender feed needs a base mint');
      extra.push(readonly(o.feed ?? (await printFeedAddress(baseMint))));
    }
    if (full.neutrality.bondQuote > 0n) {
      extra.push(writable(await ata(this.creator.address, this.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)), writable(await quoteVaultAddress(cross)), readonly(this.quoteMint), readonly(TOKEN_2022_PROGRAM_ADDRESS));
    }
    if ((full.flags & FLAG_GUARD_SCALED_UI) !== 0) {
      if (!baseMint) throw new Error('a scaled-UI guard needs a base mint');
      extra.push(readonly(baseMint));
    }
    if (full.oracleSet.extraFeeds.length > 0 && o.calendar) extra.push(readonly(o.calendar));
    ix = withAccounts(ix, o.rulesExtra ?? extra);
    return ix;
  }

  /** Sets the harness clock to `T0 + secs`. */
  at(secs: bigint): void {
    this.h.setTime(T0 + secs);
  }

  override async place(cross: CrossView, owner: KeyPairSigner, side: OrderSide, price: bigint, quantity: bigint, opts: RuledPlace = {}): Promise<PlacedOrder> {
    const view = this.view(cross.address);
    const nonce = opts.nonce ?? BigInt(view.data.ordersTotal);
    const s = salt();
    const ix = await this.commitIx(view, owner, nonce, side, price, quantity, s, opts);
    await this.h.send([ix], owner);
    const order = this.h.svm.getAccount(await orderAddress(cross.address, owner.address, nonce));
    if (!order.exists) throw new Error('order missing');
    const decoded = getOrderDecoder().decode(order.data);
    return { owner, nonce, side, price, quantity, escrow: decoded.escrow, index: decoded.index, salt: s, reveal: opts.reveal ?? true };
  }

  async commitIx(view: RView, owner: TransactionSigner, nonce: bigint, side: OrderSide, price: bigint, quantity: bigint, s: Uint8Array, opts: RuledPlace = {}): Promise<Instruction> {
    const c = view.data;
    const sealed = c.disclosure === Disclosure.Sealed;
    const escrow = opts.escrow ?? (side === OrderSide.Buy ? costCeil(quantity, price, c.priceScale) : quantity);
    const [order, orderBump] = await orderPda(view.address, owner.address, nonce);
    const commitment = sealed ? orderCommitment(view.address, owner.address, nonce, side, price, quantity, s) : new Uint8Array(32);
    const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
    const now = this.h.svm.getClock().unixTimestamp;
    const placement = placementAt(view.ext, c.closeTs, now);
    const cls = opts.class ?? 0;
    const lockSecs = opts.lockSecs ?? 0;
    const shardIndex = placement.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(owner.address, nonce, Math.min(Math.max(c.shards, 1), 8)) : placement.bucket !== 255 ? AUX_END_BASE + placement.bucket : shardIndexFor(owner.address, nonce, c.shards);
    const accounts = {
      owner,
      protocol: await protocolAddress(),
      cross: view.address,
      order,
      ...(sealed ? {} : { shard: await shardAddress(view.address, shardIndex) }),
      ...(gateMint ? { pass: await gatePassAddress(gateMint, owner.address) } : {}),
      ...(side === OrderSide.Buy
        ? { escrowMint: c.quoteMint, escrowVault: await quoteVaultAddress(view.address), ownerEscrow: await ata(owner.address, c.quoteMint, c.quoteTokenProgram), escrowTokenProgram: c.quoteTokenProgram }
        : { escrowMint: c.baseMint, escrowVault: await baseVaultAddress(view.address), ownerEscrow: await ata(owner.address, c.baseMint, c.baseTokenProgram), escrowTokenProgram: c.baseTokenProgram }),
    };
    const args = { nonce, side, escrow, commitment, price: sealed ? 0n : price, quantity: sealed ? 0n : quantity, orderBump };
    const ix = cls === 0 && lockSecs === 0 ? getCommitOrderInstruction({ ...accounts, ...args }) : getCommitOrderExtInstruction({ ...accounts, ...args, class: cls, lockSecs });
    return withAccounts(ix, await commitExtras(view.ext, view.address, owner.address, { class: cls, now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS }));
  }

  async orderExt(cross: Address, o: PlacedOrder): Promise<OrderExt> {
    const acc = this.h.svm.getAccount(await orderAddress(cross, o.owner.address, o.nonce));
    if (!acc.exists) throw new Error('order missing');
    return readOrderExt(acc.data);
  }

  async revealIx(view: RView, o: PlacedOrder): Promise<Instruction> {
    const ext = await this.orderExt(view.address, o);
    const idx = ext.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(o.owner.address, o.nonce, Math.min(Math.max(view.data.shards, 1), 8)) : ext.bucket !== 255 ? AUX_END_BASE + ext.bucket : shardIndexFor(o.owner.address, o.nonce, view.data.shards);
    const ix = getRevealOrderInstruction({
      owner: o.owner,
      cross: view.address,
      order: await orderAddress(view.address, o.owner.address, o.nonce),
      shard: await shardAddress(view.address, idx),
      price: o.price,
      quantity: o.quantity,
      salt: o.salt,
    });
    return withAccounts(ix, await revealExtras(view.ext, view.address, o.side === OrderSide.Buy));
  }

  override async revealAll(cross: CrossView, orders: PlacedOrder[]): Promise<void> {
    this.h.setTime(cross.data.closeTs + 1n);
    for (const o of orders.filter((x) => x.reveal)) await this.h.send([await this.revealIx(this.view(cross.address), o)], o.owner);
  }

  async cancelIx(view: RView, o: PlacedOrder): Promise<Instruction> {
    const c = view.data;
    const revealed = c.disclosure === Disclosure.Open;
    const ext = await this.orderExt(view.address, o);
    const idx = ext.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(o.owner.address, o.nonce, Math.min(Math.max(c.shards, 1), 8)) : ext.bucket !== 255 ? AUX_END_BASE + ext.bucket : shardIndexFor(o.owner.address, o.nonce, c.shards);
    const ix = getCancelOrderInstruction({
      owner: o.owner,
      cross: view.address,
      order: await orderAddress(view.address, o.owner.address, o.nonce),
      ...(revealed ? { shard: await shardAddress(view.address, idx) } : {}),
      baseMint: c.baseMint,
      quoteMint: c.quoteMint,
      quoteVault: await quoteVaultAddress(view.address),
      baseVault: await baseVaultAddress(view.address),
      ...(o.side === OrderSide.Buy ? { ownerQuote: await ata(o.owner.address, c.quoteMint, c.quoteTokenProgram) } : { ownerBase: await ata(o.owner.address, c.baseMint, c.baseTokenProgram) }),
      baseTokenProgram: c.baseTokenProgram,
      quoteTokenProgram: c.quoteTokenProgram,
    });
    return withAccounts(ix, await cancelExtras(view.ext, view.address, o.owner.address, { revealed, isBuy: o.side === OrderSide.Buy }));
  }

  override async cancel(cross: CrossView, o: PlacedOrder): Promise<void> {
    await this.h.send([await this.cancelIx(this.view(cross.address), o)], o.owner);
  }

  /** Merge instructions for every shard still to merge (main shards, the ending buckets up to the drawn one, the extension's), then the clear. */
  async settleIxs(view: RView, opts: { oraclePrice?: Address; oracleAccounts?: readonly Address[] } = {}): Promise<Instruction[]> {
    const book = await bookAddress(view.address);
    const x = view.ext;
    const ixs: Instruction[] = [];
    for (let i = 0; i < view.data.shards; i++) {
      if ((view.data.mergedMask >>> i) & 1) continue;
      ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, i) }));
    }
    if (x) {
      const merged = x.draw.auxMerged;
      if (x.ending.endingSecs > 0) {
        for (let b = 0; b <= lastBucket(x); b++) {
          const index = AUX_END_BASE + b;
          if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, index) }));
        }
      }
      if (x.draw.epoch > 0) {
        for (const index of auxShardIndexes(x, Number(view.data.shards)).filter((i) => i >= AUX_EXT_BASE)) {
          if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, index) }));
        }
      }
    }
    if (view.data.oracle.__option === 'Some' && !opts.oraclePrice) throw new Error('this cross has an oracle guard: pass a Pyth price update account');
    const clear = getClearInstruction({ cross: view.address, book, ...(opts.oraclePrice ? { oraclePrice: opts.oraclePrice } : {}) });
    const calendar = view.data.calendar.__option === 'Some' ? view.data.calendar.value : null;
    ixs.push(withAccounts(clear, await clearExtras(x, view.address, view.data.baseMint, { ...(opts.oracleAccounts ? { oracleAccounts: opts.oracleAccounts } : {}), calendar })));
    return ixs;
  }

  override async settle(cross: CrossView, oraclePrice?: Address, oracleAccounts?: readonly Address[]): Promise<RView> {
    this.h.setTime(cross.data.revealEndTs + 1n);
    for (const ix of await this.settleIxs(this.view(cross.address), { ...(oraclePrice ? { oraclePrice } : {}), ...(oracleAccounts ? { oracleAccounts } : {}) })) await this.h.send([ix], this.admin);
    return this.view(cross.address);
  }

  async claimIxs(view: RView, payer: TransactionSigner, o: PlacedOrder): Promise<Instruction[]> {
    const c = view.data;
    const ixs: Instruction[] = [];
    const base = c.baseBound ? { baseMint: c.baseMint, ownerBase: await ata(o.owner.address, c.baseMint, c.baseTokenProgram) } : {};
    if (c.baseBound) ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: base.ownerBase!, owner: o.owner.address, mint: c.baseMint, tokenProgram: c.baseTokenProgram }));
    const ext = await this.orderExt(view.address, o);
    const claim = getClaimInstruction({
      payer,
      cross: view.address,
      owner: o.owner.address,
      order: await orderAddress(view.address, o.owner.address, o.nonce),
      quoteVault: await quoteVaultAddress(view.address),
      ownerQuote: await ata(o.owner.address, c.quoteMint, c.quoteTokenProgram),
      ...base,
      ...(c.supplyMode === SupplyMode.Escrow ? { baseVault: await baseVaultAddress(view.address) } : {}),
      quoteMint: c.quoteMint,
      baseTokenProgram: c.baseTokenProgram,
      quoteTokenProgram: c.quoteTokenProgram,
    });
    ixs.push(withAccounts(claim, await claimExtras(view.address, o.owner.address, o.nonce, { isBuy: o.side === OrderSide.Buy, ext })));
    return ixs;
  }

  override async claimAll(cross: CrossView, orders: PlacedOrder[], cranker: KeyPairSigner = this.admin): Promise<void> {
    for (const o of orders) await this.h.send(await this.claimIxs(this.view(cross.address), cranker, o), cranker);
  }

  async finalizeIx(view: RView, payer: TransactionSigner, opts: { referrerQuote?: Address } = {}): Promise<Instruction> {
    const c = view.data;
    const ix = getFinalizeInstruction({
      payer,
      cross: view.address,
      ...(c.baseBound ? { baseMint: c.baseMint } : {}),
      ...(c.supplyMode === SupplyMode.Escrow ? { baseVault: await baseVaultAddress(view.address), proceedsBase: await ata(c.proceedsTo, c.baseMint, c.baseTokenProgram) } : {}),
      quoteMint: c.quoteMint,
      quoteVault: await quoteVaultAddress(view.address),
      feeRecipientQuote: await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram),
      integratorQuote: await ata(c.integrator, c.quoteMint, c.quoteTokenProgram),
      proceedsQuote: await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram),
      baseTokenProgram: c.baseTokenProgram,
      quoteTokenProgram: c.quoteTokenProgram,
    });
    const x = view.ext;
    if (x && x.referral.shareBps > 0) {
      const to = opts.referrerQuote ?? (await ata(x.referral.referrer, c.quoteMint, c.quoteTokenProgram));
      return withAccounts(ix, [writable(to)]);
    }
    return ix;
  }

  override async finalize(cross: CrossView): Promise<RView> {
    await this.h.send([await this.finalizeIx(this.view(cross.address), this.admin)], this.admin);
    return this.view(cross.address);
  }

  // ------------------------------------------------------------------ draws

  /** Runs a whole draw (ADR-0452): begin, wait twenty-five slots with known block hashes, finish. */
  async draw(cross: Address, purpose = 1, epoch = 0) {
    const { slotHashesFor, expectedSeed } = await import('./draws.js');
    const begun = this.h.svm.getClock().slot + 1n;
    this.h.svm.warpToSlot(begun);
    await this.h.send([getDrawBeginInstruction({ cross })], this.admin);
    const finishAt = begun + 25n;
    slotHashesFor(this, begun - 5n, finishAt);
    this.h.svm.warpToSlot(finishAt);
    await this.h.send([getDrawFinishInstruction({ cross, slotHashes: SLOT_HASHES })], this.admin);
    return { begun, seed: expectedSeed(cross, epoch, purpose, begun) };
  }

  async releaseIxs(view: RView, payer: TransactionSigner, owner: Address, nonce: bigint): Promise<Instruction[]> {
    const c = view.data;
    const ownerBase = await ata(owner, c.baseMint, c.baseTokenProgram);
    return [
      getCreateAssociatedTokenIdempotentInstruction({ payer, ata: ownerBase, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }),
      getReleaseLockedInstruction({
        cross: view.address,
        owner,
        lockup: await lockupAddress(view.address, owner, nonce),
        lockVault: await lockVaultAddress(view.address),
        baseMint: c.baseMint,
        ownerBase,
        baseTokenProgram: c.baseTokenProgram,
      }),
    ];
  }

  /** `push_refunds` for these orders: three remaining accounts each (the order, its owner, the owner's token account for the escrowed mint). */
  async pushRefundsIx(view: RView, orders: PlacedOrder[], opts: { dest?: Address[] } = {}): Promise<Instruction> {
    const c = view.data;
    const ix = getPushRefundsInstruction({
      cross: view.address,
      quoteMint: c.quoteMint,
      quoteVault: await quoteVaultAddress(view.address),
      ...(c.baseBound ? { baseMint: c.baseMint, baseVault: await baseVaultAddress(view.address) } : {}),
      quoteTokenProgram: c.quoteTokenProgram,
      baseTokenProgram: c.baseTokenProgram,
    });
    const extra = [];
    for (const [i, o] of orders.entries()) {
      const dest = opts.dest?.[i] ?? (await ata(o.owner.address, o.side === OrderSide.Buy ? c.quoteMint : c.baseMint, o.side === OrderSide.Buy ? c.quoteTokenProgram : c.baseTokenProgram));
      extra.push(writable(await orderAddress(view.address, o.owner.address, o.nonce)), writable(o.owner.address), writable(dest));
    }
    return withAccounts(ix, extra);
  }

  applicant(cross: Address, owner: Address) {
    return applicantAddress(cross, owner);
  }
}

export { CROSS_CORE_PROGRAM_ADDRESS, hasFlag, usesLocks, usesClassBook };
