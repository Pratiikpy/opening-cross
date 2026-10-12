// DLMM adapter against the mainnet lb_clmm binary: the issuer opens a pair whose active bin
// holds P*, adds liquidity around it with DLMM's own instructions, and a real swap through DLMM
// trades at that price.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide, ata } from '@opening-cross/sdk';
import { DLMM_PROGRAM_ADDRESS, binArrayAddress, binArrayIndex, binPriceQ64, buildDlmmConvictionLadder, buildOpenDlmmPair, ladderStrategy } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE, fromLegacy } from '../src/harness.js';

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
// Anchor's client only builds instructions here; it never contacts this placeholder RPC.
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// The IDL is loaded at runtime, so the builder is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const binArray = (pair: PublicKey, index: number) =>
  PublicKey.findProgramAddressSync([Buffer.from('bin_array'), pair.toBuffer(), new BN(index).toTwos(64).toArrayLike(Buffer, 'le', 8)], PID)[0];

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  await w.settle(cross);
  await w.claimAll(w.view(cross.address), orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

describe.skipIf(!existsSync(DLMM_FIXTURE))('Meteora DLMM pair', () => {
  it('opens with the active bin at P*, takes liquidity, and a real swap trades there', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);

    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const pairAcct = w.h.svm.getAccount(open.addresses.lbPair);
    if (!pairAcct.exists) throw new Error('pair missing');
    const pair = coder.decode('LbPair', Buffer.from(pairAcct.data));
    expect(pair.active_id).toBe(open.activeId);
    expect(pair.token_x_mint.toBase58()).toBe(cross.data.baseMint);
    const binPrice = Number(binPriceQ64(open.activeId, 10)) / 2 ** 64;
    expect(Math.abs(binPrice / (Number(pStar) / 1e6) - 1)).toBeLessThan(0.0005);

    // Liquidity in three bins around the active bin, with DLMM's own instructions.
    const lbPair = new PublicKey(open.addresses.lbPair);
    const index = Math.floor(open.activeId / 70);
    const arr = binArray(lbPair, index);
    const posKp = Keypair.generate();
    const creator = new PublicKey(w.creator.address);
    const signers = { [w.creator.address]: w.creator, [posKp.publicKey.toBase58()]: await createKeyPairSignerFromBytes(posKp.secretKey) };
    const reserveX = new PublicKey(open.addresses.reserveX);
    const reserveY = new PublicKey(open.addresses.reserveY);
    const tokenXMint = new PublicKey(cross.data.baseMint);
    const tokenYMint = new PublicKey(cross.data.quoteMint);
    const initArr = await m.initializeBinArray(new BN(index)).accounts({ lbPair, binArray: arr, funder: creator } as never).instruction();
    const initPos = await m.initializePosition(open.activeId - 1, 3).accounts({ payer: creator, position: posKp.publicKey, lbPair, owner: creator, rent: SYSVAR_RENT_PUBKEY } as never).instruction();
    const add = await m
      .addLiquidity2(
        {
          amountX: new BN(2_000_000_000),
          amountY: new BN(2_400_000_000),
          binLiquidityDist: [
            { binId: open.activeId - 1, distributionX: 0, distributionY: 5000 },
            { binId: open.activeId, distributionX: 5000, distributionY: 5000 },
            { binId: open.activeId + 1, distributionX: 5000, distributionY: 0 },
          ],
        },
        { slices: [] },
      )
      .accounts({
        position: posKp.publicKey,
        lbPair,
        binArrayBitmapExtension: PID,
        userTokenX: new PublicKey(await ata(w.creator.address, cross.data.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
        userTokenY: new PublicKey(await ata(w.creator.address, cross.data.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        sender: creator,
        tokenXProgram: T22,
        tokenYProgram: T22,
      } as never)
      .remainingAccounts([{ pubkey: arr, isSigner: false, isWritable: true }])
      .instruction();
    await w.h.send([cu, fromLegacy(initArr, signers), fromLegacy(initPos, signers), fromLegacy(add, signers)], w.creator);

    // Swap 10 base in through DLMM.
    const trader = await w.trader(0n, 10_000_000n);
    await w.h.ata(trader.address, w.quoteMint, w.admin);
    const before = await w.h.balanceOf(trader.address, w.quoteMint);
    const swap = await m
      .swap2(new BN(10_000_000), new BN(0), { slices: [] })
      .accounts({
        lbPair,
        binArrayBitmapExtension: PID,
        reserveX,
        reserveY,
        userTokenIn: new PublicKey(await ata(trader.address, cross.data.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
        userTokenOut: new PublicKey(await ata(trader.address, cross.data.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
        tokenXMint,
        tokenYMint,
        oracle: new PublicKey(open.addresses.oracle),
        hostFeeIn: PID,
        user: new PublicKey(trader.address),
        tokenXProgram: T22,
        tokenYProgram: T22,
        memoProgram: MEMO,
      } as never)
      .remainingAccounts([{ pubkey: arr, isSigner: false, isWritable: true }])
      .instruction();
    await w.h.send([cu, fromLegacy(swap, { [trader.address]: trader })], trader);
    const got = (await w.h.balanceOf(trader.address, w.quoteMint)) - before;
    const fair = (10_000_000n * pStar) / cross.data.priceScale;
    // Bin price within half a 10 bps step of P*, plus the DLMM fee.
    expect(got > (fair * 98n) / 100n && got <= (fair * 1001n) / 1000n).toBe(true);
    console.table({ clearing_price: Number(pStar), active_bin: open.activeId, bin_price: binPrice, quote_for_10_base_at_P: Number(fair), received: Number(got) });
  });

  it('refuses an active bin away from P*, and non-creators', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const good = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    const data = new Uint8Array(good.instruction.data!);
    new DataView(data.buffer).setInt32(8, good.activeId + 2, true); // active_id is the first arg
    expect(await w.h.fail([cu, { ...good.instruction, data }], w.creator)).toContain('StartPriceNotClearingPrice');
    const mallory = await w.trader(10_000_000_000n, 10_000_000_000n);
    const stolen = await buildOpenDlmmPair({ cross, creator: mallory, binStep: 10, baseFactor: 10_000 });
    expect(await w.h.fail([cu, stolen.instruction], mallory)).toContain('NotCreator');
  });
});

describe.skipIf(!existsSync(DLMM_FIXTURE))('Meteora DLMM conviction ladder', () => {
  it('commits unsold base tokens above P*, and buyers walk up it at rising bin prices', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);

    const posKp = Keypair.generate();
    const position = await createKeyPairSignerFromBytes(posKp.secretKey);
    const baseBefore = await w.h.balanceOf(w.creator.address, w.baseMint);
    const BINS = 20;
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position, activeId: open.activeId, bins: BINS, baseAmount: 2_000_000_000n, shape: 'taper' });
    expect(ladder.upperBinId - ladder.lowerBinId + 1).toBe(BINS);
    await w.h.send([cu, ...ladder.instructions], w.creator);
    // The issuer's tokens left its wallet and sit in the pair's X reserve, none of it quote.
    // DLMM keeps a few atoms of rounding dust with the depositor; everything else moves into the pair's X reserve.
    const moved = baseBefore - (await w.h.balanceOf(w.creator.address, w.baseMint));
    expect(moved <= 2_000_000_000n && moved >= 2_000_000_000n - 100n).toBe(true);
    const tokenAmount = (addr: string) => {
      const acct = w.h.svm.getAccount(addr as never);
      if (!acct.exists) throw new Error('reserve missing');
      return Buffer.from(acct.data).readBigUInt64LE(64);
    };
    expect(tokenAmount(open.addresses.reserveX)).toBe(moved);
    expect(tokenAmount(open.addresses.reserveY)).toBe(0n);

    // A buyer swaps quote for base through DLMM's own instruction, over the bin arrays the ladder uses.
    const lbPair = new PublicKey(open.addresses.lbPair);
    const arrays = [] as PublicKey[];
    for (let i = binArrayIndex(open.activeId); i <= binArrayIndex(ladder.upperBinId); i++) arrays.push(new PublicKey(binArrayAddress(open.addresses.lbPair, i)));
    const buy = async (quoteIn: bigint) => {
      const buyer = await w.trader(0n, 0n);
      await w.h.fund(w.quoteMint, w.admin, buyer.address, quoteIn);
      await w.h.ata(buyer.address, w.baseMint, w.admin);
      const ix = await m
        .swap2(new BN(quoteIn.toString()), new BN(0), { slices: [] })
        .accounts({
          lbPair,
          binArrayBitmapExtension: PID,
          reserveX: new PublicKey(open.addresses.reserveX),
          reserveY: new PublicKey(open.addresses.reserveY),
          userTokenIn: new PublicKey(await ata(buyer.address, cross.data.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
          userTokenOut: new PublicKey(await ata(buyer.address, cross.data.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
          tokenXMint: new PublicKey(cross.data.baseMint),
          tokenYMint: new PublicKey(cross.data.quoteMint),
          oracle: new PublicKey(open.addresses.oracle),
          hostFeeIn: PID,
          user: new PublicKey(buyer.address),
          tokenXProgram: T22,
          tokenYProgram: T22,
          memoProgram: MEMO,
        } as never)
        .remainingAccounts(arrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
        .instruction();
      await w.h.send([cu, fromLegacy(ix, { [buyer.address]: buyer })], buyer);
      const got = await w.h.balanceOf(buyer.address, w.baseMint);
      return { got, price: Number(quoteIn) / Number(got) };
    };
    const small = await buy(100_000_000n);
    const large = await buy(1_500_000_000n);
    const firstBin = Number(binPriceQ64(ladder.lowerBinId, 10)) / 2 ** 64;
    const topBin = Number(binPriceQ64(ladder.upperBinId, 10)) / 2 ** 64;
    console.table({ clearing_price: Number(pStar) / 1e6, first_ladder_bin: firstBin, top_ladder_bin: topBin, small_buy_avg_price: small.price, large_buy_avg_price: large.price });
    // Nothing is sold below the first ladder bin (less the pair's fee), and a bigger buy climbs further up the ladder.
    expect(small.got > 0n && large.got > small.got).toBe(true);
    expect(small.price >= firstBin * 0.9999).toBe(true);
    expect(large.price > small.price).toBe(true);
    expect(large.price <= topBin * 1.03).toBe(true);
  });

  it('maps shapes to Meteora one-sided strategies and bin ids to their arrays', () => {
    expect([ladderStrategy('flat'), ladderStrategy('taper'), ladderStrategy('wall')]).toEqual([6, 7, 8]);
    const strat = idl.types.find((t: { name: string }) => t.name === 'StrategyType').type.variants.map((v: { name: string }) => v.name);
    expect(strat.slice(6, 9)).toEqual(['SpotImBalanced', 'CurveImBalanced', 'BidAskImBalanced']);
    expect(binArrayIndex(-1)).toBe(-1);
    expect(binArrayIndex(69)).toBe(0);
    expect(binArrayIndex(70)).toBe(1);
  });
});
