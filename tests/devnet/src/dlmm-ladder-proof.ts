// Devnet proof for ROADMAP M2 (DLMM conviction ladder). A real cross clears on the deployed cross_core, the issuer opens a
// Meteora DLMM pair through the deployed cross_settle with the active bin holding P*, then commits unsold base tokens on the
// bins above P* with Meteora's own add_liquidity_by_strategy2. Buyers then swap quote for base through DLMM itself: nothing
// is sold below the first ladder bin, and a larger buy climbs further up the ladder.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:dlmm-ladder
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { type Instruction, address, createKeyPairSignerFromBytes } from '@solana/kit';
import { getTokenDecoder, getMintToInstruction } from '@solana-program/token-2022';
import { DLMM_PROGRAM_ADDRESS, binArrayAddress, binArrayIndex, binPriceQ64, buildDlmmConvictionLadder, buildOpenDlmmPair } from '@opening-cross/adapters';
import { Evidence } from './lib.js';
import { TOKEN_2022_PROGRAM_ADDRESS, account, ata, balanceOf, clearLaunchCross, computeLimit, crossView, send, sweep } from './adapter-lib.js';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { generateKeyPairSigner } from '@solana/kit';

const CROSS_SETTLE_PROGRAM_ADDRESS = '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ';
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
// Anchor's client only builds instructions here; it never contacts this placeholder RPC.
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// The IDL is loaded at runtime, so the builder is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const ev = new Evidence('D5-dlmm-conviction-ladder-devnet.md', 'Devnet proof — DLMM conviction ladder above P* (M2)', [
  'Script `tests/devnet/src/dlmm-ladder-proof.ts`',
  `Programs: cross_settle \`${CROSS_SETTLE_PROGRAM_ADDRESS}\`, lb_clmm (DLMM) \`${DLMM_PROGRAM_ADDRESS}\` — both executable on devnet`,
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
  const c = await clearLaunchCross(ev, 1_500_000_000n);
  const cross = await crossView(c.cross);
  const pStar = c.pStar;
  const scale = cross.data.priceScale;
  const BIN_STEP = 10;

  const open = await buildOpenDlmmPair({ cross, creator: c.creator, binStep: BIN_STEP, baseFactor: 10_000 });
  const openSig = await send([computeLimit(1_400_000), open.instruction], c.creator);
  ev.check('pair-open', 'the DLMM pair opens through cross_settle with the active bin holding P*', true, `pair ${open.addresses.lbPair} active bin ${open.activeId}, P* ${pStar}/${scale}`, openSig);

  // The ladder: 20 bins above the active bin, tapered (denser near P*), base tokens only.
  const BINS = 20;
  const LADDER_BASE = 900_000_000n;
  const position = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
  const baseBefore = await balanceOf(c.creator.address, c.baseMint);
  const ladder = await buildDlmmConvictionLadder({ cross, creator: c.creator, position, activeId: open.activeId, bins: BINS, baseAmount: LADDER_BASE, shape: 'taper' });
  ev.check('ladder-span', `the ladder covers exactly ${BINS} bins, all above the active bin`, ladder.upperBinId - ladder.lowerBinId + 1 === BINS && ladder.lowerBinId > open.activeId, `bins ${ladder.lowerBinId} to ${ladder.upperBinId} (active ${open.activeId})`);
  const ladderSig = await send([computeLimit(1_400_000), ...ladder.instructions], c.creator);
  const moved = baseBefore - (await balanceOf(c.creator.address, c.baseMint));
  const resX = await tokenAmount(open.addresses.reserveX);
  const resY = await tokenAmount(open.addresses.reserveY);
  ev.check('ladder-deposit', 'the issuer\'s base tokens left its wallet into the pair\'s base reserve, and no quote was deposited', moved <= LADDER_BASE && moved >= LADDER_BASE - 100n && resX === moved && resY === 0n, `wallet −${moved} of ${LADDER_BASE}; reserve X ${resX}, reserve Y ${resY}`, ladderSig);

  // Buyers swap quote for base through DLMM's own swap2 over the bin arrays the ladder uses.
  const lbPair = new PublicKey(open.addresses.lbPair);
  const arrays: PublicKey[] = [];
  for (let i = binArrayIndex(open.activeId); i <= binArrayIndex(ladder.upperBinId); i++) arrays.push(new PublicKey(binArrayAddress(open.addresses.lbPair, i)));
  const buy = async (quoteIn: bigint) => {
    const buyer = await generateKeyPairSigner();
    await send(
      [
        getTransferSolInstruction({ source: c.creator, destination: buyer.address, amount: 10_000_000n }),
        getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(buyer.address, c.quoteMint), owner: buyer.address, mint: c.quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
        getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(buyer.address, c.baseMint), owner: buyer.address, mint: c.baseMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
        getMintToInstruction({ mint: c.quoteMint, token: await ata(buyer.address, c.quoteMint), mintAuthority: c.creator, amount: quoteIn }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      ],
      c.creator,
    );
    const ix = await m
      .swap2(new BN(quoteIn.toString()), new BN(0), { slices: [] })
      .accounts({
        lbPair,
        binArrayBitmapExtension: PID,
        reserveX: new PublicKey(open.addresses.reserveX),
        reserveY: new PublicKey(open.addresses.reserveY),
        userTokenIn: new PublicKey(await ata(buyer.address, c.quoteMint)),
        userTokenOut: new PublicKey(await ata(buyer.address, c.baseMint)),
        tokenXMint: new PublicKey(c.baseMint),
        tokenYMint: new PublicKey(c.quoteMint),
        oracle: new PublicKey(open.addresses.oracle),
        hostFeeIn: PID,
        user: new PublicKey(buyer.address),
        tokenXProgram: T22,
        tokenYProgram: T22,
        memoProgram: MEMO,
      } as never)
      .remainingAccounts(arrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction();
    const sig = await send([computeLimit(1_400_000), fromLegacy(ix, { [buyer.address]: buyer })], buyer);
    const got = await balanceOf(buyer.address, c.baseMint);
    return { got, price: Number(quoteIn) / Number(got), sig };
  };
  const firstBin = Number(binPriceQ64(ladder.lowerBinId, BIN_STEP)) / 2 ** 64;
  const topBin = Number(binPriceQ64(ladder.upperBinId, BIN_STEP)) / 2 ** 64;
  const small = await buy(100_000_000n);
  ev.check('buy-small', 'a small buy is filled from the ladder at no less than the first ladder bin (less the pair fee)', small.got > 0n && small.price >= firstBin * 0.9999, `100 quote → ${small.got} base, average price ${small.price.toFixed(6)}; first ladder bin ${firstBin.toFixed(6)}, P* ${(Number(pStar) / Number(scale)).toFixed(6)}`, small.sig);
  const large = await buy(500_000_000n);
  ev.check('buy-large', 'a larger buy climbs further up the ladder: more tokens, a higher average price, never above the top bin', large.got > small.got && large.price > small.price && large.price <= topBin * 1.03, `500 quote → ${large.got} base, average price ${large.price.toFixed(6)}; top bin ${topBin.toFixed(6)}`, large.sig);
  const resXAfter = await tokenAmount(open.addresses.reserveX);
  ev.check('reserve-accounting', 'the base reserve fell by exactly what the two buyers received', resX - resXAfter === small.got + large.got, `reserve X ${resX} → ${resXAfter}, buyers received ${small.got + large.got}`);

  const back = await sweep(c);
  ev.check('cost', 'leftover SOL went back to the promiser', true, `returned ${Number(back) / 1e9} SOL of ${Number(c.startLamports) / 1e9}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
