// Devnet landing latency and throughput for placing bids, and the latency of settlement (ROADMAP DP13).
//
// One open-book launch on the deployed cross_core: 40 bids sent one at a time (each timed from fetching a blockhash to a confirmed
// status), then 40 more with ten in flight, then the settlement instructions timed one by one and the result checked
// against the independent reference. Public devnet is shared and throttled, so these are floor-quality numbers for a
// public endpoint, not a statement about the program.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:latency
import { readFileSync } from 'node:fs';
import {
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
} from '@solana-program/token-2022';
import { CrossKind, CrossState, Disclosure, OrderSide, SupplyMode, buildCreateCross, buildPlaceOrder, buildSettleBook, crossAddress, getCrossDecoder } from '@opening-cross/sdk';
import { referenceClear, type RefOrder } from '@opening-cross/verifier';
import { Evidence, ROOT, rpc } from './lib.js';

const ev = new Evidence('DP13-devnet-latency.md', 'Devnet landing latency and settlement (DP13)', ['Script `tests/devnet/src/latency-proof.ts`']);
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

async function sendTimed(ixs: Instruction[], payer: KeyPairSigner): Promise<{ signature: string; ms: number }> {
  const t0 = Date.now();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  const signature = getSignatureFromTransaction(tx);
  const sent = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false }).send();
      break;
    } catch (e) {
      if (attempt >= 6 || !String(e).includes('429')) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  for (let i = 0; i < 180; i++) {
    const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { signature, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${signature} not confirmed within 45 s`);
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const summary = (xs: number[]) => `n=${xs.length}, p50 ${pct(xs, 0.5)} ms, p90 ${pct(xs, 0.9)} ms, p99 ${pct(xs, 0.99)} ms, max ${Math.max(...xs)} ms`;

async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}

async function main() {
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
  const newMint = async () => {
    const mint = await generateKeyPairSigner();
    const space = getMintSize();
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    await sendTimed([getCreateAccountInstruction({ payer: operator, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: operator.address, freezeAuthority: null })], operator);
    return mint.address;
  };
  const ata = async (mint: string) => (await findAssociatedTokenPda({ owner: operator.address, mint: mint as never, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
  const quote = await newMint();
  await sendTimed([getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(quote), owner: operator.address, mint: quote, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint: quote, token: await ata(quote), mintAuthority: operator, amount: 1_000_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], operator);

  const crossId = BigInt(Date.now());
  const cross = await crossAddress(operator.address, crossId);
  const base = await newMint();
  await sendTimed([getSetAuthorityInstruction({ owned: base, owner: operator, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(base), owner: operator.address, mint: base, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], operator);
  const schedule = [{ price: 1_000_000n, quantity: 4_000_000_000n }, { price: 1_500_000n, quantity: 4_000_000_000n }];
  const now = await chainTime();
  // Public devnet answers slowly under throttling; leave room for 80 bids before the window closes.
  const closeTs = now + 900n;
  const built = await buildCreateCross({
    creator: operator, baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: operator.address, gateMint: null,
    shards: 4, maxOrders: 128, proceedsTo: operator.address, schedule, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  });
  await sendTimed([built.create], operator);
  for (const s of built.shards) await sendTimed([s], operator);
  const view = async () => ({ address: cross, data: getCrossDecoder().decode(((await fetchEncodedAccount(rpc, cross, { commitment: 'confirmed' })) as { data: Uint8Array }).data) });

  const bid = (n: number): [bigint, bigint] => [1_000_000n + BigInt(n % 10) * 100_000n, 10_000_000n + BigInt(n) * 1_000_000n];
  const refBuys: RefOrder[] = [];

  // Sequential: one bid at a time.
  const seq: number[] = [];
  const t0 = Date.now();
  for (let n = 0; n < 40; n++) {
    const [price, quantity] = bid(n);
    const r = await sendTimed([await buildPlaceOrder({ cross: await view(), owner: operator, nonce: BigInt(n), side: OrderSide.Buy, price, quantity })], operator);
    seq.push(r.ms);
    if (n % 10 === 9) console.log(`sequential ${n + 1}/40, last ${r.ms} ms`);
    refBuys.push({ side: 'buy', price, quantity });
  }
  const seqSeconds = (Date.now() - t0) / 1000;
  ev.check('latency-sequential', 'sequential bids confirm within five seconds at the 90th percentile', pct(seq, 0.9) <= 5_000, `${summary(seq)}; ${(40 / seqSeconds).toFixed(2)} bids/s including build and read`);

  // Concurrent: ten in flight at a time, against the same four shards.
  const burst: number[] = [];
  const cview = await view();
  const t1 = Date.now();
  let failed = 0;
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(
      Array.from({ length: 10 }, async (_, k) => {
        const n = 40 + batch * 10 + k;
        const [price, quantity] = bid(n);
        try {
          const r = await sendTimed([await buildPlaceOrder({ cross: cview, owner: operator, nonce: BigInt(n), side: OrderSide.Buy, price, quantity })], operator);
          burst.push(r.ms);
          refBuys.push({ side: 'buy', price, quantity });
        } catch (e) {
          failed++;
          console.log(`burst bid ${n} failed: ${String(e).slice(0, 160)}`);
        }
      }),
    );
  }
  const burstSeconds = (Date.now() - t1) / 1000;
  ev.check('throughput-concurrent', 'bids sent ten at a time all land', failed === 0, `${summary(burst)}; ${(burst.length / burstSeconds).toFixed(2)} bids/s with ten in flight; ${failed} failed`);

  // Settlement.
  while ((await chainTime()) < closeTs + 1n) await new Promise((r) => setTimeout(r, 2_000));
  const ixs = await buildSettleBook(await view());
  const settle: number[] = [];
  for (const ix of ixs) settle.push((await sendTimed([ix], operator)).ms);
  const cleared = await view();
  const ref = referenceClear([...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity })), ...refBuys], GRID, null)!;
  const got = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  ev.check('settle', `settling ${refBuys.length} bids took ${ixs.length} transactions and the clearing price equals the independent reference`, cleared.data.state === CrossState.Cleared && got?.price === ref.price && got?.matched === ref.matched, `${summary(settle)}; P* ${got?.price} (reference ${ref.price}), matched ${got?.matched} (reference ${ref.matched}), total ${(settle.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
