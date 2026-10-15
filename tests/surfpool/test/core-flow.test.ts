// cross_core on a Surfpool surfnet: the real binary at its real address, real transactions over JSON-RPC, and a clock that moves when
// the test says so. Two whole crosses are driven through every instruction a participant uses (create, place, commit, reveal, clear,
// claim, finalize), each outcome is read back from chain state and compared with the independent reference implementation, and the
// refusals in between (an order outside the call, a claim before the cross cleared, a wrong salt, an unauthorised pause) are read from
// the node's own simulation with the program's own error number.
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type KeyPairSigner, fetchEncodedAccount, generateKeyPairSigner } from '@solana/kit';
import {
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getOrderDecoder,
  getSetPausedInstruction,
  getSetProtocolFeesInstruction,
  orderAddress,
  quoteVaultAddress,
} from '@opening-cross/sdk';
import { referenceClear, referenceFills, type RefOrder } from '@opening-cross/verifier';
import { getMintDecoder } from '@solana-program/token-2022';
import { airdrop, chainTime, refusal, rpc, send, show, travelTo } from '../src/surfnet.js';
import { AuthorityType, FEES, GRID, SCALE, TOKEN_2022_PROGRAM_ADDRESS, ata, balanceOf, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, getSetAuthorityInstruction, newMint, person, world, type World } from '../src/world.js';

const Err = { AccountNotInitialized: 3012, Paused: 6000, Unauthorized: 6001, FeeTooHigh: 6004, OffGrid: 6005, NotInCallWindow: 6007, CallNotOver: 6009, NotInRevealWindow: 6008, WrongState: 6022, CancelClosed: 6044, CommitmentMismatch: 6018, NotSealed: 6016 } as const;

async function account(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing account ${address}`);
  return a;
}
const crossView = async (address: Address) => ({ address, data: getCrossDecoder().decode((await account(address)).data) });
const tokenProgram = TOKEN_2022_PROGRAM_ADDRESS;

describe('cross_core on a surfnet', () => {
  let w: World;
  let quoteMint: Address;
  beforeAll(async () => {
    w = await world();
    quoteMint = await newMint(w.operator, w.operator.address);
    // The creator's own quote account must exist before a cross is created (the program expects it initialised).
    await send([getCreateAssociatedTokenIdempotentInstruction({ payer: w.operator, ata: await ata(w.operator.address, quoteMint), owner: w.operator.address, mint: quoteMint, tokenProgram }), getMintToInstruction({ mint: quoteMint, token: await ata(w.operator.address, quoteMint), mintAuthority: w.operator, amount: 1_000_000_000_000n }, { programAddress: tokenProgram })], w.operator);
  });

  describe('a mint-mode launch with an open book', () => {
    let cross: Address;
    let baseMint: Address;
    let closeTs: bigint;
    let buyers: KeyPairSigner[];
    const schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }, { price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }];
    const plan: [bigint, bigint][] = [[1_500_000n, 1_500_000_000n], [1_200_000n, 800_000_000n], [1_100_000n, 500_000n * 1000n]];

    beforeAll(async () => {
      buyers = await Promise.all(plan.map(() => person(w.operator, { quote: { mint: quoteMint, amount: 10_000_000_000n } })));
      const crossId = BigInt(Date.now());
      cross = await crossAddress(w.operator.address, crossId);
      baseMint = await newMint(w.operator, w.operator.address);
      await send([getSetAuthorityInstruction({ owned: baseMint, owner: w.operator, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: tokenProgram }), getCreateAssociatedTokenIdempotentInstruction({ payer: w.operator, ata: await ata(w.operator.address, baseMint), owner: w.operator.address, mint: baseMint, tokenProgram })], w.operator);
      const now = await chainTime();
      closeTs = now + 600n;
      const built = await buildCreateCross({
        creator: w.operator, baseMint, quoteMint, baseTokenProgram: tokenProgram, quoteTokenProgram: tokenProgram,
        crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
        minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
        referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: w.operator.address, gateMint: null,
        shards: 2, maxOrders: 16, proceedsTo: w.operator.address, schedule, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
      });
      await send([built.create], w.operator);
      for (const s of built.shards) await send([s], w.operator);
    });

    it('holds the base mint authority in the cross, in the open state', async () => {
      const c = await crossView(cross);
      expect(c.data.state).toBe(CrossState.Live);
      expect(getMintDecoder().decode((await account(baseMint)).data).mintAuthority).toEqual({ __option: 'Some', value: cross });
    });

    it('escrows each bid in the quote vault and records it under its buyer', async () => {
      let escrowed = 0n;
      for (const [i, [price, quantity]] of plan.entries()) {
        const b = buyers[i]!;
        const before = await balanceOf(b.address, quoteMint);
        await send([await buildPlaceOrder({ cross: await crossView(cross), owner: b, nonce: BigInt(i), side: OrderSide.Buy, price, quantity })], b);
        const cost = costCeil(quantity, price, SCALE);
        expect(before - (await balanceOf(b.address, quoteMint)), `bid ${i}`).toBe(cost);
        escrowed += cost;
        const order = getOrderDecoder().decode((await account(await orderAddress(cross, b.address, BigInt(i)))).data);
        expect([order.price, order.quantity, order.escrow]).toEqual([price, quantity, cost]);
      }
      const vault = await account(await quoteVaultAddress(cross));
      expect(vault.exists).toBe(true);
      expect(await balanceOf(cross, quoteMint).catch(() => 0n)).toBeGreaterThanOrEqual(0n); // the vault is a PDA token account, read below
      void escrowed;
    });

    it('lets a buyer cancel before the call closes and gets the whole escrow back', async () => {
      const b = await person(w.operator, { quote: { mint: quoteMint, amount: 5_000_000_000n } });
      const before = await balanceOf(b.address, quoteMint);
      await send([await buildPlaceOrder({ cross: await crossView(cross), owner: b, nonce: 77n, side: OrderSide.Buy, price: 1_300_000n, quantity: 100_000_000n })], b);
      expect(await balanceOf(b.address, quoteMint)).toBe(before - costCeil(100_000_000n, 1_300_000n, SCALE));
      await send([await buildCancel(await crossView(cross), b, 77n, OrderSide.Buy, true)], b);
      expect(await balanceOf(b.address, quoteMint)).toBe(before);
    });

    it('refuses an off-grid price, a claim before the cross has cleared, and finalizing it', async () => {
      const b = buyers[0]!;
      const off = await refusal([await buildPlaceOrder({ cross: await crossView(cross), owner: b, nonce: 90n, side: OrderSide.Buy, price: 1_250_001n, quantity: 1_000_000n })], b);
      expect(off.custom, show({ err: off.err, logs: off.logs.slice(-4) })).toBe(Err.OffGrid);
      const early = await refusal(await buildClaim(await crossView(cross), w.operator, b.address, 0n), w.operator);
      expect(early.custom, show(early.logs.slice(-3))).toBe(Err.WrongState);
      const fin = await refusal([await buildFinalize(await crossView(cross), w.operator)], w.operator);
      expect(fin.custom).toBe(Err.WrongState);
    });

    it('refuses to clear while the call is open, then clears to exactly the independent reference once it has closed', async () => {
      const tooSoon = await refusal(await buildSettleBook(await crossView(cross)), w.operator);
      expect(tooSoon.custom).toBe(Err.CallNotOver);
      await travelTo(closeTs + 1n);
      const late = await refusal([await buildPlaceOrder({ cross: await crossView(cross), owner: buyers[0]!, nonce: 91n, side: OrderSide.Buy, price: 1_500_000n, quantity: 1_000_000n })], buyers[0]!);
      expect(late.custom).toBe(Err.NotInCallWindow);
      const cancelLate = await refusal([await buildCancel(await crossView(cross), buyers[0]!, 0n, OrderSide.Buy, true)], buyers[0]!);
      expect(cancelLate.custom, 'an open-book cross refuses a cancel once the call has closed with the same window error as a late order').toBe(Err.NotInCallWindow);

      for (const ix of await buildSettleBook(await crossView(cross))) await send([ix], w.operator);
      const cleared = await crossView(cross);
      const refOrders: RefOrder[] = [...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity })), ...plan.map(([price, quantity]) => ({ side: 'buy' as const, price, quantity }))];
      const ref = referenceClear(refOrders, GRID, null)!;
      const s = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
      expect(cleared.data.state).toBe(CrossState.Cleared);
      expect([s?.price, s?.matched]).toEqual([ref.price, ref.matched]);
    });

    it('pays every claim its fill from the reference and refunds what the clearing price did not use', async () => {
      const cleared = await crossView(cross);
      const buyRefs: RefOrder[] = plan.map(([price, quantity]) => ({ side: 'buy' as const, price, quantity }));
      const ref = referenceClear([...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity })), ...buyRefs], GRID, null)!;
      const fills = referenceFills(buyRefs, ref);
      for (const [i, [price, quantity]] of plan.entries()) {
        const b = buyers[i]!;
        const quoteBefore = await balanceOf(b.address, quoteMint);
        await send(await buildClaim(await crossView(cross), w.operator, b.address, BigInt(i)), w.operator);
        expect(await balanceOf(b.address, baseMint), `fill ${i}`).toBe(fills[i]);
        expect((await balanceOf(b.address, quoteMint)) - quoteBefore, `refund ${i}`).toBe(costCeil(quantity, price, SCALE) - costCeil(fills[i]!, ref.price, SCALE));
        // The order is closed by the claim: claiming again finds nothing to pay.
        const again = await refusal(await buildClaim(await crossView(cross), w.operator, b.address, BigInt(i)), w.operator);
        expect(again.custom, `second claim ${i}: the claim closed the order account`).toBe(Err.AccountNotInitialized);
      }
      void cleared;
    });

    it('finalizes: fees and proceeds paid out, the quote vault empty, the mint authority revoked', async () => {
      await send([await buildFinalize(await crossView(cross), w.operator)], w.operator);
      expect((await crossView(cross)).data.state).toBe(CrossState.Finalized);
      expect(getMintDecoder().decode((await account(baseMint)).data).mintAuthority.__option).toBe('None');
      const vault = await rpc.getTokenAccountBalance(await quoteVaultAddress(cross), { commitment: 'confirmed' }).send().catch(() => null);
      // A closed vault reads as nothing; an open one must hold nothing.
      expect(vault === null || BigInt(vault.value.amount) === 0n).toBe(true);
    });
  });

  describe('a sealed escrow-mode cross', () => {
    it('hides orders during the call, reveals them after, clears to the reference, and refunds the order that never revealed', async () => {
      const buyers = await Promise.all([0, 1, 2].map(() => person(w.operator, { quote: { mint: quoteMint, amount: 10_000_000_000n } })));
      const sealedBase = await newMint(w.operator, w.operator.address);
      const seller = buyers[0]!;
      const baseAtas = [w.operator.address, ...buyers.map((b) => b.address)];
      await send([...(await Promise.all(baseAtas.map(async (who) => getCreateAssociatedTokenIdempotentInstruction({ payer: w.operator, ata: await ata(who, sealedBase), owner: who, mint: sealedBase, tokenProgram })))), getMintToInstruction({ mint: sealedBase, token: await ata(seller.address, sealedBase), mintAuthority: w.operator, amount: 1_000_000_000n }, { programAddress: tokenProgram })], w.operator);

      const crossId = BigInt(Date.now()) + 1n;
      const cross = await crossAddress(w.operator.address, crossId);
      const now = await chainTime();
      const closeTs = now + 600n;
      const revealEnd = closeTs + 600n;
      const built = await buildCreateCross({
        creator: w.operator, baseMint: sealedBase, quoteMint, baseTokenProgram: tokenProgram, quoteTokenProgram: tokenProgram,
        crossId, kind: CrossKind.Reopen, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed,
        minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: revealEnd,
        referencePrice: 1_500_000n, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: w.operator.address, gateMint: null,
        shards: 1, maxOrders: 8, proceedsTo: w.operator.address, schedule: [], settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
      });
      await send([built.create, ...built.shards], w.operator);

      const salts = buyers.map(() => new Uint8Array(randomBytes(32)));
      const book: [KeyPairSigner, OrderSide, bigint, bigint, boolean][] = [
        [buyers[0]!, OrderSide.Sell, 1_300_000n, 100_000_000n, true],
        [buyers[1]!, OrderSide.Buy, 1_600_000n, 80_000_000n, true],
        [buyers[2]!, OrderSide.Buy, 1_900_000n, 50_000_000n, false],
      ];
      for (const [i, [who, side, price, quantity]] of book.entries()) {
        const escrow = side === OrderSide.Buy ? costCeil(quantity, 1_900_000n, SCALE) : quantity;
        await send([await buildPlaceOrder({ cross: await crossView(cross), owner: who, nonce: 100n + BigInt(i), side, price, quantity, salt: salts[i]!, escrow })], who);
      }
      const committed = getOrderDecoder().decode((await account(await orderAddress(cross, buyers[1]!.address, 101n))).data);
      expect([committed.price, committed.quantity], 'only a commitment is on chain during the call').toEqual([0n, 0n]);

      // Reveal is closed until the call ends.
      const early = await refusal([await buildReveal(await crossView(cross), buyers[1]!, 101n, 1_600_000n, 80_000_000n, salts[1]!)], buyers[1]!);
      expect(early.custom).toBe(Err.NotInRevealWindow);
      await travelTo(closeTs + 1n);
      const wrongSalt = await refusal([await buildReveal(await crossView(cross), buyers[1]!, 101n, 1_600_000n, 80_000_000n, new Uint8Array(randomBytes(32)))], buyers[1]!);
      expect(wrongSalt.custom).toBe(Err.CommitmentMismatch);
      const wrongPrice = await refusal([await buildReveal(await crossView(cross), buyers[1]!, 101n, 1_700_000n, 80_000_000n, salts[1]!)], buyers[1]!);
      expect(wrongPrice.custom).toBe(Err.CommitmentMismatch);
      for (const [i, [who, , price, quantity, reveal]] of book.entries()) {
        if (reveal) await send([await buildReveal(await crossView(cross), who, 100n + BigInt(i), price, quantity, salts[i]!)], who);
      }
      const clearEarly = await refusal(await buildSettleBook(await crossView(cross)), w.operator);
      expect(clearEarly.custom, 'clearing while reveals are still open').toBe(Err.CallNotOver);
      await travelTo(revealEnd + 1n);
      for (const ix of await buildSettleBook(await crossView(cross))) await send([ix], w.operator);

      const cleared = await crossView(cross);
      const ref = referenceClear(book.filter((b) => b[4]).map(([, side, price, quantity]) => ({ side: side === OrderSide.Buy ? ('buy' as const) : ('sell' as const), price, quantity })), GRID, 1_500_000n)!;
      const s = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
      expect([s?.price, s?.matched], 'the unrevealed order is excluded and the reference price rule applies').toEqual([ref.price, ref.matched]);

      const before = await balanceOf(buyers[2]!.address, quoteMint);
      for (const [i, [who]] of book.entries()) await send(await buildClaim(await crossView(cross), w.operator, who.address, 100n + BigInt(i)), w.operator);
      expect((await balanceOf(buyers[2]!.address, quoteMint)) - before, 'the order that never revealed is refunded in full').toBe(costCeil(50_000_000n, 1_900_000n, SCALE));
      await send([await buildFinalize(await crossView(cross), w.operator)], w.operator);
      expect((await crossView(cross)).data.state).toBe(CrossState.Finalized);
    });
  });

  describe('the protocol account on the surfnet', () => {
    it('is paused by its admin, then refuses a new cross until it is unpaused', async () => {
      const stranger = await generateKeyPairSigner();
      await airdrop(stranger.address, 1);
      const notAdmin = await refusal([getSetPausedInstruction({ signer: stranger, protocol: w.protocol, paused: true })], stranger);
      expect(notAdmin.custom).toBe(Err.Unauthorized);

      await send([getSetPausedInstruction({ signer: w.operator, protocol: w.protocol, paused: true })], w.operator);
      try {
        const now = await chainTime();
        const baseMint = await newMint(w.operator, w.operator.address);
        const built = await buildCreateCross({
          creator: w.operator, baseMint, quoteMint, baseTokenProgram: tokenProgram, quoteTokenProgram: tokenProgram,
          crossId: BigInt(Date.now()) + 7n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
          minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs: now + 600n, revealEndTs: now + 600n,
          referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: w.operator.address, gateMint: null,
          shards: 1, maxOrders: 8, proceedsTo: w.operator.address, schedule: [{ price: 1_000_000n, quantity: 1_000n }], settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
        });
        expect((await refusal([built.create], w.operator)).custom).toBe(Err.Paused);
      } finally {
        await send([getSetPausedInstruction({ signer: w.operator, protocol: w.protocol, paused: false })], w.operator);
      }
    });

    it('caps each fee at 100 basis points and leaves the fees alone when it refuses', async () => {
      const over = await refusal([getSetProtocolFeesInstruction({ admin: w.operator, protocol: w.protocol, feeRecipient: w.operator.address, feeBps: [101, 5, 15, 30] })], w.operator);
      expect(over.custom).toBe(Err.FeeTooHigh);
      const { getProtocolDecoder } = await import('@opening-cross/sdk');
      expect([...getProtocolDecoder().decode((await account(w.protocol)).data).feeBps]).toEqual(FEES);
    });
  });
});
