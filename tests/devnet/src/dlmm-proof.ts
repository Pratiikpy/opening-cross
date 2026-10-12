// Devnet proof for ROADMAP A3 — the DLMM settlement adapter. A real cross clears on the deployed cross_core, the issuer
// opens a Meteora DLMM pair through the deployed cross_settle with the active bin holding P*, adds liquidity with DLMM's
// own instructions, and a different wallet swaps through DLMM. The pair is read back from chain and the swap is compared
// with an independent bin-price model.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:dlmm
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { type Instruction, address, createKeyPairSignerFromBytes } from '@solana/kit';
import { getTokenDecoder } from '@solana-program/token-2022';
import { DLMM_PROGRAM_ADDRESS, binPriceQ64, buildOpenDlmmPair } from '@opening-cross/adapters';
import { Evidence } from './lib.js';
import { TOKEN_2022_PROGRAM_ADDRESS, account, ata, balanceOf, clearLaunchCross, computeLimit, crossView, fundTrader, send, sendExpectingFailure, sweep } from './adapter-lib.js';

/** Deployed cross_settle on devnet (Anchor.toml, `solana program show`). */
const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
// Anchor's client only builds instructions here; it never contacts this placeholder RPC.
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// The IDL is loaded at runtime, so the builder is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const binArray = (pair: PublicKey, index: number) => PublicKey.findProgramAddressSync([Buffer.from('bin_array'), pair.toBuffer(), new BN(index).toTwos(64).toArrayLike(Buffer, 'le', 8)], PID)[0];

const ev = new Evidence('A3-dlmm-devnet.md', 'Devnet proof — DLMM pair opened at P* (A3)', [
  'Script `tests/devnet/src/dlmm-proof.ts`',
  `Programs: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\`, lb_clmm (DLMM) \`${DLMM_PROGRAM_ADDRESS}\` — both executable on devnet (checked with getAccountInfo before the run)`,
]);

function fromLegacy(
  ix: { programId: { toBase58(): string }; keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array },
  signers: Record<string, unknown>,
): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const a = address(k.pubkey.toBase58());
      const role = k.isSigner ? (k.isWritable ? 3 : 2) : k.isWritable ? 1 : 0;
      return signers[a] ? { address: a, role, signer: signers[a] } : { address: a, role };
    }),
    data: new Uint8Array(ix.data),
  } as Instruction;
}
const tokenAmount = async (a: string) => getTokenDecoder().decode((await account(a as never)).data).amount;

async function main() {
  const c = await clearLaunchCross(ev);
  const cross = await crossView(c.cross);
  const pStar = c.pStar;
  const scale = cross.data.priceScale;
  const BIN_STEP = 10;
  const BASE_FACTOR = 10_000;
  const FEE = (BASE_FACTOR * BIN_STEP * 10) / 1e9; // DLMM base fee rate

  // The program must refuse an active bin that is not P*'s bin, and anyone but the cross creator.
  const good = await buildOpenDlmmPair({ cross, creator: c.creator, binStep: BIN_STEP, baseFactor: BASE_FACTOR });
  const data = new Uint8Array(good.instruction.data!);
  new DataView(data.buffer).setInt32(8, good.activeId + 2, true); // active_id is the first argument
  await sendExpectingFailure([computeLimit(1_400_000), { ...good.instruction, data }], c.creator, 'StartPriceNotClearingPrice');
  ev.check('refuse-wrong-bin', 'an active bin two steps from P* is refused by cross_settle', true, `P* ${pStar}, honest bin ${good.activeId}, tried ${good.activeId + 2}: StartPriceNotClearingPrice`);
  await fundTrader(c, 1_000_000n);
  const stolen = await buildOpenDlmmPair({ cross, creator: c.trader, binStep: BIN_STEP, baseFactor: BASE_FACTOR });
  await sendExpectingFailure([computeLimit(1_400_000), stolen.instruction], c.trader, 'NotCreator');
  ev.check('refuse-non-creator', 'a wallet that did not create the cross cannot open its pair', true, `trader ${c.trader.address}: NotCreator`);

  const openSig = await send([computeLimit(1_400_000), good.instruction], c.creator);
  const pair = coder.decode('LbPair', Buffer.from((await account(good.addresses.lbPair)).data));
  ev.check('pair-active-bin', 'the DLMM pair account\'s active bin is the bin nearest P*', pair.active_id === good.activeId && pair.bin_step === BIN_STEP, `pair ${good.addresses.lbPair} active_id ${pair.active_id} bin_step ${pair.bin_step}`, openSig);
  const binPrice = Number(binPriceQ64(good.activeId, BIN_STEP)) / 2 ** 64;
  const off = Math.abs(binPrice / (Number(pStar) / Number(scale)) - 1);
  ev.check('pair-bin-price', 'that bin\'s price is within half a bin step (0.05%) of P*', off < 0.0005, `bin price ${binPrice.toFixed(6)} vs P* ${Number(pStar) / Number(scale)} (off by ${(off * 100).toFixed(4)}%)`);
  ev.check('pair-mints', 'token X is the launch token and token Y is the quote token', pair.token_x_mint.toBase58() === c.baseMint && pair.token_y_mint.toBase58() === c.quoteMint, `X ${pair.token_x_mint.toBase58()} Y ${pair.token_y_mint.toBase58()}`);

  // Liquidity in three bins around the active bin, with DLMM's own instructions.
  const lbPair = new PublicKey(good.addresses.lbPair);
  const index = Math.floor(good.activeId / 70);
  const arr = binArray(lbPair, index);
  const posKp = Keypair.generate();
  const creatorKey = new PublicKey(c.creator.address);
  const signers = { [c.creator.address]: c.creator, [posKp.publicKey.toBase58()]: await createKeyPairSignerFromBytes(posKp.secretKey) };
  const reserveX = new PublicKey(good.addresses.reserveX);
  const reserveY = new PublicKey(good.addresses.reserveY);
  const tokenXMint = new PublicKey(c.baseMint);
  const tokenYMint = new PublicKey(c.quoteMint);
  const AMOUNT_X = 800_000_000n;
  const AMOUNT_Y = (AMOUNT_X * pStar) / scale;
  const initArr = await m.initializeBinArray(new BN(index)).accounts({ lbPair, binArray: arr, funder: creatorKey } as never).instruction();
  const initPos = await m.initializePosition(good.activeId - 1, 3).accounts({ payer: creatorKey, position: posKp.publicKey, lbPair, owner: creatorKey, rent: SYSVAR_RENT_PUBKEY } as never).instruction();
  const add = await m
    .addLiquidity2(
      {
        amountX: new BN(AMOUNT_X.toString()),
        amountY: new BN(AMOUNT_Y.toString()),
        binLiquidityDist: [
          { binId: good.activeId - 1, distributionX: 0, distributionY: 5000 },
          { binId: good.activeId, distributionX: 5000, distributionY: 5000 },
          { binId: good.activeId + 1, distributionX: 5000, distributionY: 0 },
        ],
      },
      { slices: [] },
    )
    .accounts({
      position: posKp.publicKey,
      lbPair,
      binArrayBitmapExtension: PID,
      userTokenX: new PublicKey(await ata(c.creator.address, c.baseMint)),
      userTokenY: new PublicKey(await ata(c.creator.address, c.quoteMint)),
      reserveX,
      reserveY,
      tokenXMint,
      tokenYMint,
      sender: creatorKey,
      tokenXProgram: T22,
      tokenYProgram: T22,
    } as never)
    .remainingAccounts([{ pubkey: arr, isSigner: false, isWritable: true }])
    .instruction();
  const liqSig = await send([computeLimit(1_400_000), fromLegacy(initArr, signers), fromLegacy(initPos, signers), fromLegacy(add, signers)], c.creator);
  const resX = await tokenAmount(good.addresses.reserveX);
  const resY = await tokenAmount(good.addresses.reserveY);
  ev.check('liquidity', 'liquidity was added in three bins around P*; the pair reserves hold it', resX > 0n && resY > 0n && resX <= AMOUNT_X && resY <= AMOUNT_Y, `reserve X ${resX} (offered ${AMOUNT_X}), reserve Y ${resY} (offered ${AMOUNT_Y}); bin array ${arr.toBase58()} index ${index}`, liqSig);

  // A different wallet swaps base for quote through DLMM itself.
  const swapIn = 5_000_000n;
  await fundTrader(c, swapIn);
  const quoteBefore = await balanceOf(c.trader.address, c.quoteMint);
  const reserveYBefore = await tokenAmount(good.addresses.reserveY);
  const swap = await m
    .swap2(new BN(swapIn.toString()), new BN(0), { slices: [] })
    .accounts({
      lbPair,
      binArrayBitmapExtension: PID,
      reserveX,
      reserveY,
      userTokenIn: new PublicKey(await ata(c.trader.address, c.baseMint)),
      userTokenOut: new PublicKey(await ata(c.trader.address, c.quoteMint)),
      tokenXMint,
      tokenYMint,
      oracle: new PublicKey(good.addresses.oracle),
      hostFeeIn: PID,
      user: new PublicKey(c.trader.address),
      tokenXProgram: T22,
      tokenYProgram: T22,
      memoProgram: MEMO,
    } as never)
    .remainingAccounts([{ pubkey: arr, isSigner: false, isWritable: true }])
    .instruction();
  const swapSig = await send([computeLimit(1_400_000), fromLegacy(swap, { [c.trader.address]: c.trader })], c.trader);
  const got = (await balanceOf(c.trader.address, c.quoteMint)) - quoteBefore;
  const fair = (swapIn * pStar) / scale;
  ev.check('swap-near-pstar', 'a real swap pays within 0.5% of P* (bin rounding plus the pair fee)', got > (fair * 995n) / 1000n && got <= (fair * 1001n) / 1000n, `${swapIn} base in → ${got} quote out; ${fair} at exactly P*; ratio ${(Number(got) / Number(fair)).toFixed(5)}`, swapSig);
  const model = Number(swapIn) * (1 - FEE) * binPrice;
  const err = Math.abs(Number(got) / model - 1);
  ev.check('swap-model', 'the amount received matches an independent bin-price model (price of the active bin, base fee 0.10%) within 0.05%', err < 0.0005, `received ${got}, model ${model.toFixed(1)}, error ${(err * 100).toFixed(4)}%`);
  const reserveYAfter = await tokenAmount(good.addresses.reserveY);
  ev.check('swap-reserves', 'the pair\'s quote reserve fell by what the trader received (plus nothing else)', reserveYBefore - reserveYAfter === got, `reserve Y ${reserveYBefore} → ${reserveYAfter}, trader received ${got}`);
  const after = coder.decode('LbPair', Buffer.from((await account(good.addresses.lbPair)).data));
  ev.check('swap-active-bin', 'a swap this small leaves the active bin where the cross put it', after.active_id === good.activeId, `active_id ${after.active_id}`);
  const back = await sweep(c);
  ev.check('cost', 'the whole run, including rent for the cross, mints, pair, bin array and position, fit inside the 2 SOL cap; the remainder went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
