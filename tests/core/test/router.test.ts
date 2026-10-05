// Best-execution router (ROADMAP D6), against live data. The real mainnet USDC and JUP mint
// accounts are loaded into LiteSVM (mint authority handed to the test so it can fund traders),
// an open cross is built around Jupiter's live price for the pair, and the router compares that
// cross with a live Jupiter route for the same size. The prediction is then checked against what
// actually happens: the order is placed, the book settles and the order is claimed, and the
// realized fill and quote paid must equal the router's indicative figures exactly.
import { describe, expect, it } from 'vitest';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, getTokenDecoder } from '@solana-program/token';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildPlaceOrder,
  buildSettleBook,
  getCrossDecoder,
  getInitProtocolInstruction,
  protocolAddress,
} from '@opening-cross/sdk';
import { bestExecution, quoteCross, quoteJupiter } from '@opening-cross/router';
import { fileURLToPath } from 'node:url';

const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const JUP = address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
const SO = fileURLToPath(new URL('../../../target/deploy/cross_core.so', import.meta.url));
const T0 = 1_800_000_000n;
const SCALE = 1_000_000n; // JUP has 6 decimals: prices are USDC atoms per 1 JUP

async function setup() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, SO);
  const setTime = (t: bigint) => { const c = svm.getClock(); svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, t)); };
  setTime(T0);
  const send = async (ixs: Instruction[], payer: KeyPairSigner) => {
    svm.expireBlockhash();
    const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }, m), (m) => appendTransactionMessageInstructions(ixs, m)));
    const res = svm.sendTransaction(tx as Parameters<LiteSVM['sendTransaction']>[0]);
    if (res instanceof FailedTransactionMetadata) throw new Error(`${res.toString()}\n${res.meta().logs().join('\n')}`);
  };
  const wallet = async () => { const w = await generateKeyPairSigner(); svm.airdrop(w.address, lamports(10_000_000_000n)); return w; };
  const admin = await wallet();
  // Real mainnet mint accounts, with the mint authority replaced so the test can fund traders.
  const rpc = createSolanaRpc(process.env.MAINNET_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
  for (const mint of [USDC, JUP]) {
    const acct = await fetchEncodedAccount(rpc, mint);
    if (!acct.exists) throw new Error(`mainnet mint ${mint} not found`);
    const data = new Uint8Array(acct.data);
    data.set([1, 0, 0, 0], 0);
    data.set(getAddressEncoder().encode(admin.address), 4);
    svm.setAccount({ address: mint, data, executable: false, lamports: lamports(acct.lamports), programAddress: TOKEN_PROGRAM_ADDRESS, space: BigInt(data.length) });
  }
  const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const fund = async (mint: Address, owner: Address, amount: bigint) => {
    const a = await ata(owner, mint);
    const ixs: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: admin, ata: a, owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })];
    if (amount > 0n) ixs.push(getMintToInstruction({ mint, token: a, mintAuthority: admin, amount }));
    await send(ixs, admin);
  };
  const balance = async (owner: Address, mint: Address) => { const x = svm.getAccount(await ata(owner, mint)); return x.exists ? getTokenDecoder().decode(x.data).amount : 0n; };
  await send([getInitProtocolInstruction({ admin, protocol: await protocolAddress(), guardian: admin.address, feeRecipient: admin.address, feeBps: [30, 5, 15, 30] })], admin);
  const fetchAcct = async (a: Address) => { const x = svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; };
  return { svm, setTime, send, wallet, admin, fund, balance, fetchAcct };
}

describe('router against live Jupiter and real mints', () => {
  it('predicts the cross outcome exactly and compares it with a live route at the same moment', async () => {
    const env = await setup();
    const { send, wallet, admin, fund, balance, fetchAcct, setTime } = env;
    const qty = 100_000_000n; // 100 JUP
    const live = await quoteJupiter({ baseMint: JUP, quoteMint: USDC, intent: { side: 'buy', quantity: qty } });
    if (!live.available) throw new Error(live.reason);
    const mid = (live.quote * SCALE) / live.base; // USDC atoms per JUP, from the live route
    const tick = mid / 1000n > 0n ? mid / 1000n : 1n; // 10 bps grid
    const min = mid - 100n * tick;

    const issuer = await wallet();
    await fund(USDC, issuer.address, 10_000_000n);
    for (const m of [USDC, JUP]) await fund(m, admin.address, 0n);
    const { cross, create, shards } = await buildCreateCross({
      creator: issuer, baseMint: JUP, quoteMint: USDC, baseTokenProgram: TOKEN_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
      crossId: 1n, kind: CrossKind.Reopen, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open,
      minPrice: min, tick, ticks: 200, priceScale: SCALE, openTs: T0, closeTs: T0 + 100n, revealEndTs: T0 + 100n,
      referencePrice: min + 100n * tick, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: admin.address, gateMint: null,
      shards: 1, maxOrders: 32, proceedsTo: issuer.address, schedule: [], oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n,
    });
    await send([create], issuer);
    for (const s of shards) await send([s], issuer);
    const view = () => ({ address: cross, data: getCrossDecoder().decode(env.svm.getAccount(cross).exists ? (env.svm.getAccount(cross) as { data: Uint8Array }).data : new Uint8Array()) });

    // Resting liquidity: sellers 30 bps below and 20 bps above the live price, one competing bid.
    const s1 = await wallet(); const s2 = await wallet(); const b1 = await wallet();
    await fund(JUP, s1.address, 60_000_000n); await fund(JUP, s2.address, 80_000_000n); await fund(USDC, b1.address, 1_000_000_000n);
    for (const s of [s1, s2, b1]) for (const m of [USDC, JUP]) await fund(m, s.address, 0n);
    await send([await buildPlaceOrder({ cross: view(), owner: s1, nonce: 0n, side: OrderSide.Sell, price: min + 97n * tick, quantity: 60_000_000n })], s1);
    await send([await buildPlaceOrder({ cross: view(), owner: s2, nonce: 0n, side: OrderSide.Sell, price: min + 102n * tick, quantity: 80_000_000n })], s2);
    await send([await buildPlaceOrder({ cross: view(), owner: b1, nonce: 0n, side: OrderSide.Buy, price: min + 98n * tick, quantity: 30_000_000n })], b1);

    // The report, with both venues priced at the same moment.
    const intent = { side: 'buy' as const, quantity: qty, limitPrice: min + 104n * tick };
    const [cq, dq] = await Promise.all([quoteCross(fetchAcct, cross, intent, T0 + 10n), quoteJupiter({ baseMint: JUP, quoteMint: USDC, intent })]);
    const report = bestExecution(intent, cq, dq, SCALE);
    console.log(JSON.stringify(report, null, 2));
    expect(report.schema).toBe('opening-cross/best-execution/v1');
    expect(cq.available && cq.indicative?.prints).toBe(true);
    expect(dq.available).toBe(true);
    expect(report.comparison.crossPrice).not.toBeNull();
    expect(report.comparison.dexPrice).not.toBeNull();
    expect(['cross', 'dex', 'split']).toContain(report.recommendation);

    // Now do it: the realized outcome must equal the prediction.
    const me = await wallet();
    await fund(USDC, me.address, 1_000_000_000n); await fund(JUP, me.address, 0n);
    await send([await buildPlaceOrder({ cross: view(), owner: me, nonce: 0n, side: OrderSide.Buy, price: intent.limitPrice, quantity: qty })], me);
    setTime(T0 + 101n);
    for (const ix of await buildSettleBook(view())) await send([ix], admin);
    const before = await balance(me.address, USDC);
    await send(await buildClaim(view(), admin, me.address, 0n), admin);
    if (!cq.available || !cq.indicative) throw new Error('unreachable');
    const c = view().data;
    expect(c.clearing.__option === 'Some' && c.clearing.value.price).toBe(cq.indicative.price);
    expect(await balance(me.address, JUP)).toBe(cq.indicative.fill);
    // The escrow was taken at placement; the claim refunds the excess. Net spend is the quote paid.
    expect(1_000_000_000n - (await balance(me.address, USDC))).toBe(cq.indicative.quote);
    expect(await balance(me.address, USDC)).toBeGreaterThan(before);
  }, 120_000);

  it('a sealed cross gives no indicative price, and unavailable venues are reported, not guessed', async () => {
    const env = await setup();
    const { send, wallet, admin, fund, fetchAcct } = env;
    const issuer = await wallet();
    await fund(USDC, issuer.address, 10_000_000n);
    const { cross, create, shards } = await buildCreateCross({
      creator: issuer, baseMint: JUP, quoteMint: USDC, baseTokenProgram: TOKEN_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
      crossId: 2n, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed,
      minPrice: 100_000n, tick: 1_000n, ticks: 100, priceScale: SCALE, openTs: T0, closeTs: T0 + 100n, revealEndTs: T0 + 200n,
      referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: admin.address, gateMint: null,
      shards: 1, maxOrders: 8, proceedsTo: issuer.address, schedule: [], oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n,
    });
    await send([create], issuer);
    for (const s of shards) await send([s], issuer);
    const sealed = await quoteCross(fetchAcct, cross, { side: 'buy', quantity: 1_000_000n }, T0 + 1n);
    expect(sealed.available && sealed.disclosure).toBe('sealed');
    expect(sealed.available && sealed.indicative).toBeNull();
    expect(await quoteCross(fetchAcct, cross, { side: 'buy', quantity: 1n }, T0 + 100n)).toMatchObject({ available: false, reason: 'call period has closed' });
    expect(await quoteCross(fetchAcct, cross, { side: 'buy', quantity: 1n, limitPrice: 100_500n }, T0 + 1n)).toMatchObject({ available: false, reason: 'limit price is not on the cross grid' });
    expect(await quoteCross(fetchAcct, admin.address, { side: 'buy', quantity: 1n }, T0)).toMatchObject({ available: false, reason: 'not an Opening Cross account' });
    expect(await quoteCross(fetchAcct, (await generateKeyPairSigner()).address, { side: 'buy', quantity: 1n }, T0)).toMatchObject({ available: false, reason: 'cross not found' });
    expect(await quoteCross(fetchAcct, USDC, { side: 'buy', quantity: 1n }, T0)).toMatchObject({ available: false, reason: 'not an Opening Cross account' });
    const noRoute = await quoteJupiter({ baseMint: cross, quoteMint: USDC, intent: { side: 'buy', quantity: 1_000_000n } });
    expect(noRoute.available).toBe(false);
    const report = bestExecution({ side: 'buy', quantity: 1_000_000n }, sealed, noRoute, SCALE);
    expect(report.recommendation).toBe('none');
    expect(report.caveats.join(' ')).toMatch(/Sealed cross/);
    expect(report.caveats.join(' ')).toMatch(/DEX route unavailable: Jupiter answered HTTP/);
  }, 60_000);
});
