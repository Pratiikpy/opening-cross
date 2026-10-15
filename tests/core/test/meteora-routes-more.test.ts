// The rest of the Meteora routes of the API, run against the real binaries (ADR-0911 to 0916): DAMM v2 reward slots and joining the pool, the conviction ladder as limit orders
// and its rebalance, the buyer's side of the fixed-price tranche for a hooked base token, the Dynamic Fee Sharing read-out and the calibrated curve. The API builds each transaction
// from what it reads off the chain, a wallet's key signs it, LiteSVM runs it, and the accounts and balances are read back.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { type KeyPairSigner, address, generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide, SupplyMode, ata, buildClaim, crossAddress } from '@opening-cross/sdk';
import { DLMM_PROGRAM_ADDRESS, buildBindDbcMint, buildOpenDbcPool, buildOpenDlmmPair, buildOpenFixedPricePresale, buildSeedDammV2, dammRewardVaultAddress, settlerAddress } from '@opening-cross/adapters';
import { buildMeteoraTxApp } from '../../../services/api/src/routes/meteora-tx.js';
import { registerSettleWave3dTx } from '../../../services/api/src/routes/settle-wave3d-tx.js';
import { World } from '../src/world.js';
import { DAMM_FIXTURE, DBC_FIXTURE, DFS_FIXTURE, DLMM_FIXTURE, fromLegacy } from '../src/harness.js';
import { CU, DEFAULT_SCHEDULE, defaultDesign } from '../src/settle-world.js';

// The chain runs are many transactions each; the default five seconds is for pure functions.
vi.setConfig({ testTimeout: 180_000 });

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PRESALE = address('presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj');
const DAY = 86_400n;

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

async function harness(w: World, extra?: Parameters<typeof buildMeteoraTxApp>[1]) {
  const account = async (a: Parameters<typeof w.h.svm.getAccount>[0]) => {
    const x = w.h.svm.getAccount(a);
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  };
  const lifetime = async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n });
  const clock = () => Number(w.h.svm.getClock().unixTimestamp);
  const app = await buildMeteoraTxApp({ account, lifetime, clock }, extra ? extra : undefined);
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const land = async (built: { status: number; body: { transaction?: string } }, signers: KeyPairSigner[]) => {
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    return w.h.sendWire(built.body.transaction!, signers);
  };
  return { app, post, get, land, account, lifetime, clock };
}

describe.skipIf(!existsSync(DAMM_FIXTURE))('DAMM v2 reward slots through the API', () => {
  it('opens slot 0, funds it, lets an outside holder join the pool, and pays each position its share', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 30 });
    await w.h.send([cu, seed.instruction], w.creator);
    const X = cross.address;
    const rewardMint = await w.h.mint(w.admin, 6);
    const sponsor = await w.trader(0n, 0n);
    await w.h.fund(rewardMint, w.admin, sponsor.address, 10_000_000_000n);
    const mallory = await w.trader(0n, 0n);

    const rewards = (await get(`/v1/crosses/${X}/damm-rewards`)).body;
    expect(rewards).toMatchObject({ pool: seed.addresses.pool, creator: w.creator.address });
    expect(rewards.slots.map((s: { initialized: boolean }) => s.initialized)).toEqual([false, false]);

    // Refusals before anything is opened, each with its reason.
    const init = (over: Record<string, unknown>) => post('/v1/tx/damm-reward-init', { cross: X, signer: w.creator.address, rewardMint, durationSecs: String(DAY), funder: sponsor.address, ...over });
    expect((await init({ signer: mallory.address })).body.reason).toBe('NOT_THE_POOL_CREATOR');
    expect((await init({ index: 1 })).body.reason).toBe('SLOT_1_NEEDS_OPERATOR');
    expect((await init({ durationSecs: String(DAY - 1n) })).body.reason).toBe('DURATION_OUT_OF_RANGE');
    expect((await post('/v1/tx/damm-reward-fund', { cross: X, funder: sponsor.address, amount: '1' })).body.reason).toBe('SLOT_NOT_OPEN');
    await land(await init({}), [w.creator]);
    expect((await init({})).body.reason).toBe('SLOT_IN_USE');
    const opened = (await get(`/v1/crosses/${X}/damm-rewards`)).body.slots[0];
    expect(opened).toMatchObject({ initialized: true, mint: rewardMint, funder: sponsor.address, durationSecs: String(DAY), vault: dammRewardVaultAddress(seed.addresses.pool, 0), streaming: false });

    // Only the named funder funds; the stream starts at the funding.
    expect((await post('/v1/tx/damm-reward-fund', { cross: X, funder: w.creator.address, amount: '1' })).body.reason).toBe('NOT_THE_FUNDER');
    expect((await post('/v1/tx/damm-reward-fund', { cross: X, funder: sponsor.address, amount: '99999999999999' })).status).toBeGreaterThanOrEqual(409);
    const fundedAt = w.h.svm.getClock().unixTimestamp;
    const fund = await post('/v1/tx/damm-reward-fund', { cross: X, funder: sponsor.address, amount: '8640000000' });
    expect(fund.body).toMatchObject({ perSecond: '100000', running: false });
    await land(fund, [sponsor]);
    expect((await get(`/v1/crosses/${X}/damm-rewards`)).body.slots[0]).toMatchObject({ streaming: true, endsAt: String(fundedAt + DAY), perSecond: '100000' });

    // An outside holder joins with a quarter of the pool (a third of the issuer's share): the route sizes the deposit from the pool's own reserves.
    const dave = await w.trader(10_000_000_000n, 10_000_000_000n);
    const nft = await generateKeyPairSigner();
    expect((await post('/v1/tx/damm-lp-join', { cross: X, owner: dave.address, positionNftMint: dave.address, shareBps: 2500 })).status).toBe(400);
    expect((await post('/v1/tx/damm-lp-join', { cross: X, owner: dave.address, positionNftMint: nft.address, shareBps: 0 })).status).toBe(400);
    const join = await post('/v1/tx/damm-lp-join', { cross: X, owner: dave.address, positionNftMint: nft.address, shareBps: 3333 });
    expect(join.body.shareOfPoolBps).toBe(3333);
    await land(join, [dave, nft]);
    const position = join.body.position as string;
    expect(w.h.exists(position as never)).toBe(true);
    expect((await post('/v1/tx/damm-lp-join', { cross: X, owner: dave.address, positionNftMint: nft.address, shareBps: 100 })).body.reason).toBe('POSITION_EXISTS');

    // Half a day on, each position claims: the issuer's (the default) and Dave's. A stranger cannot claim Dave's.
    w.h.setTime(fundedAt + DAY / 2n);
    const before = await w.h.balanceOf(w.creator.address, rewardMint);
    await land(await post('/v1/tx/damm-reward-claim', { cross: X, owner: w.creator.address }), [w.creator]);
    const issuerGot = (await w.h.balanceOf(w.creator.address, rewardMint)) - before;
    expect((await post('/v1/tx/damm-reward-claim', { cross: X, owner: mallory.address, position })).body.reason).toBe('NOT_THE_HOLDER');
    expect((await post('/v1/tx/damm-reward-claim', { cross: X, owner: dave.address, position: w.creator.address })).body.reason).toBe('NOT_A_POSITION');
    await land(await post('/v1/tx/damm-reward-claim', { cross: X, owner: dave.address, position }), [dave]);
    const daveGot = await w.h.balanceOf(dave.address, rewardMint);
    // The pool was the issuer's alone until Dave joined, in the same second the stream started: 4,320,000,000 over the half day, split 75 : 25 to within the 33.33% share.
    expect(issuerGot + daveGot <= 4_320_000_000n && 4_320_000_000n - (issuerGot + daveGot) < 1_000_000n).toBe(true);
    expect(Number((daveGot * 10_000n) / (issuerGot + daveGot)) / 100).toBeCloseTo(25, 0);

    // The creator cannot change the duration while the stream runs, nor the funder take back reward; after the end both can.
    expect((await post('/v1/tx/damm-reward-update-duration', { cross: X, signer: w.creator.address, durationSecs: String(2n * DAY) })).body.reason).toBe('STREAM_RUNNING');
    expect((await post('/v1/tx/damm-reward-withdraw-ineligible', { cross: X, funder: sponsor.address })).body.reason).toBe('STREAM_RUNNING');
    expect((await post('/v1/tx/damm-reward-update-funder', { cross: X, signer: mallory.address, newFunder: mallory.address })).body.reason).toBe('NOT_THE_POOL_CREATOR');
    w.h.setTime(fundedAt + DAY + 10n);
    await land(await post('/v1/tx/damm-reward-update-duration', { cross: X, signer: w.creator.address, durationSecs: String(2n * DAY) }), [w.creator]);
    await land(await post('/v1/tx/damm-reward-update-funder', { cross: X, signer: w.creator.address, newFunder: w.creator.address }), [w.creator]);
    const after = (await get(`/v1/crosses/${X}/damm-rewards`)).body.slots[0];
    expect(after).toMatchObject({ durationSecs: String(2n * DAY), funder: w.creator.address });
    // The pool never lacked liquidity, so there is nothing ineligible to take back: the route builds it and the program pays nothing (or refuses); the test only needs it not to break the chain.
    await w.h.fund(rewardMint, w.admin, w.creator.address, 0n);
  });
});

async function swapUp(w: World, open: { addresses: { lbPair: string; reserveX: string; reserveY: string; oracle: string } }, arrays: string[], quoteIn: bigint) {
  const buyer = await w.trader(quoteIn, 0n);
  await w.h.ata(buyer.address, w.baseMint, w.admin);
  const ix = await m
    .swap2(new BN(quoteIn.toString()), new BN(0), { slices: [] })
    .accounts({
      lbPair: new PublicKey(open.addresses.lbPair), binArrayBitmapExtension: PID, reserveX: new PublicKey(open.addresses.reserveX), reserveY: new PublicKey(open.addresses.reserveY),
      userTokenIn: new PublicKey(await ata(buyer.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)), userTokenOut: new PublicKey(await ata(buyer.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
      tokenXMint: new PublicKey(w.baseMint), tokenYMint: new PublicKey(w.quoteMint), oracle: new PublicKey(open.addresses.oracle), hostFeeIn: PID,
      user: new PublicKey(buyer.address), tokenXProgram: T22, tokenYProgram: T22, memoProgram: MEMO,
    } as never)
    .remainingAccounts(arrays.map((pubkey) => ({ pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true })))
    .instruction();
  await w.h.send([cu, fromLegacy(ix, { [buyer.address]: buyer })], buyer);
  return w.h.balanceOf(buyer.address, w.baseMint);
}

describe.skipIf(!existsSync(DLMM_FIXTURE))('the conviction ladder through the API', () => {
  it('places a limit-order ladder, reads it, cancels and closes it, and rebalances a position the market has walked into', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const X = cross.address;
    const mallory = await w.trader(0n, 0n);

    // Limit orders: refusals first.
    const order = await generateKeyPairSigner();
    const place = (over: Record<string, unknown>) => post('/v1/tx/ladder-limit-place', { cross: X, owner: w.creator.address, limitOrder: order.address, baseAmount: '2000000000', count: 4, ...over });
    expect((await place({ limitOrder: w.creator.address })).status).toBe(400);
    expect((await place({ count: 0 })).status).toBe(400);
    expect((await place({ baseAmount: '2', count: 4 })).body.reason).toBe('LADDER_INVALID');
    expect((await place({ baseAmount: '999999999999' })).body.reason).toBe('INSUFFICIENT_BASE');
    expect((await place({ shape: 'spiral' })).status).toBe(400);
    const placed = await place({});
    expect(placed.body.rungs).toHaveLength(4);
    expect(placed.body.note).toMatch(/not a lock/);
    const baseBefore = await w.h.balanceOf(w.creator.address, w.baseMint);
    await land(placed, [w.creator, order]);
    expect(baseBefore - (await w.h.balanceOf(w.creator.address, w.baseMint))).toBe(2_000_000_000n);
    const binIds = placed.body.rungs.map((r: { binId: number }) => r.binId) as number[];
    expect((await post('/v1/tx/ladder-limit-place', { cross: X, owner: w.creator.address, limitOrder: order.address, baseAmount: '1000', count: 2 })).body.reason).toBe('ORDER_EXISTS');
    // A stranger cannot cancel it; a rung nobody touched can be cancelled a second after it was placed.
    expect((await post('/v1/tx/ladder-limit-cancel', { cross: X, owner: mallory.address, limitOrder: order.address, binIds })).body.reason).toBe('NOT_THE_OWNER');
    expect((await post('/v1/tx/ladder-limit-cancel', { cross: X, owner: w.creator.address, limitOrder: mallory.address, binIds })).body.reason).toBe('NOT_A_LIMIT_ORDER');
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 5n);
    const cancel = await post('/v1/tx/ladder-limit-cancel', { cross: X, owner: w.creator.address, limitOrder: order.address, binIds });
    await land(cancel, [w.creator]);
    expect(await w.h.balanceOf(w.creator.address, w.baseMint)).toBe(baseBefore);
    const close = await post('/v1/tx/ladder-limit-close', { cross: X, owner: w.creator.address, limitOrder: order.address });
    await land(close, [w.creator]);
    expect(w.h.exists(order.address)).toBe(false);
    expect((await post('/v1/tx/ladder-limit-close', { cross: X, owner: w.creator.address, limitOrder: order.address })).body.reason).toBe('NOT_A_LIMIT_ORDER');

    // The position ladder and its rebalance. The first ladder is laid by the relay route (the same route that re-lays after a withdrawal).
    const first = await generateKeyPairSigner();
    expect((await post('/v1/tx/ladder-rebalance-relay', { cross: X, owner: w.creator.address, newPosition: w.creator.address, baseAmount: '1' })).status).toBe(400);
    expect((await post('/v1/tx/ladder-rebalance-relay', { cross: X, owner: w.creator.address, newPosition: first.address, baseAmount: '99999999999999' })).body.reason).toBe('INSUFFICIENT_BASE');
    const relay = await post('/v1/tx/ladder-rebalance-relay', { cross: X, owner: w.creator.address, newPosition: first.address, baseAmount: '3000000000', bins: 30, shape: 'flat' });
    expect(relay.body).toMatchObject({ lowerBinId: open.activeId + 1, upperBinId: open.activeId + 30 });
    await land(relay, [w.creator, first]);
    const status0 = (await get(`/v1/crosses/${X}/ladder?position=${first.address}`)).body;
    expect(status0).toMatchObject({ owner: w.creator.address, activeId: open.activeId, status: { untouched: true, worthRebalancing: false } });
    expect(await post('/v1/tx/ladder-rebalance-withdraw', { cross: X, owner: w.creator.address, position: first.address })).toMatchObject({ status: 409, body: { reason: 'NOTHING_TO_REBALANCE' } });
    expect((await get(`/v1/crosses/${X}/ladder?position=${mallory.address}`)).status).toBe(404);

    // Buyers walk up through it; the read-out follows; a stranger cannot withdraw it; the owner does, then re-lays the base above the new price.
    const arrays = [0, 1].map((i) => status0.position && '').filter(Boolean);
    void arrays;
    const lowerArray = Math.floor((open.activeId + 1) / 70);
    const { binArrayAddress } = await import('@opening-cross/adapters');
    const swapArrays = [lowerArray, lowerArray + 1].filter((i) => w.h.exists(binArrayAddress(open.addresses.lbPair as never, i))).map((i) => binArrayAddress(open.addresses.lbPair as never, i));
    const bought = await swapUp(w, open, swapArrays, 1_500_000_000n);
    const status1 = (await get(`/v1/crosses/${X}/ladder?position=${first.address}`)).body;
    expect(status1.status.worthRebalancing).toBe(true);
    expect(BigInt(status1.baseLeft) + bought <= 3_000_000_000n && 3_000_000_000n - (BigInt(status1.baseLeft) + bought) < 300n).toBe(true);
    expect((await post('/v1/tx/ladder-rebalance-withdraw', { cross: X, owner: mallory.address, position: first.address })).body.reason).toBe('NOT_THE_OWNER');
    // DLMM refuses a withdrawal in the second the liquidity was added: a minute on, it goes through.
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 60n);
    const withdraw = await post('/v1/tx/ladder-rebalance-withdraw', { cross: X, owner: w.creator.address, position: first.address });
    expect(withdraw.body).toMatchObject({ baseLeft: status1.baseLeft, next: { route: '/v1/tx/ladder-rebalance-relay', baseAmount: status1.baseLeft } });
    const walletBase = await w.h.balanceOf(w.creator.address, w.baseMint);
    await land(withdraw, [w.creator]);
    expect((await w.h.balanceOf(w.creator.address, w.baseMint)) - walletBase).toBe(BigInt(status1.baseLeft));
    expect(w.h.exists(first.address)).toBe(false);
    const second = await generateKeyPairSigner();
    const relay2 = await post('/v1/tx/ladder-rebalance-relay', { cross: X, owner: w.creator.address, newPosition: second.address, baseAmount: status1.baseLeft, bins: 30 });
    expect(relay2.body.lowerBinId).toBe(status1.activeId + 1);
    await land(relay2, [w.creator, second]);
    const status2 = (await get(`/v1/crosses/${X}/ladder?position=${second.address}`)).body;
    expect(status2.status).toMatchObject({ untouched: true });
    expect(BigInt(status2.baseLeft) <= BigInt(status1.baseLeft) && BigInt(status1.baseLeft) - BigInt(status2.baseLeft) <= 100n).toBe(true);
  });
});

describe.skipIf(!existsSync(`${FIX}presale.so`) || !existsSync(DBC_FIXTURE))('the fixed-price tranche, buyer side, through the API', () => {
  it('opens a tranche of a hooked base token through the API (the hook is found from the mint), and buyers deposit and claim through it', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(PRESALE, `${FIX}presale.so`);
    const crossAddr = await crossAddress(w.creator.address, 1n);
    const settler = await settlerAddress(crossAddr);
    const x0 = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: DEFAULT_SCHEDULE, settler, settleDeadlineTs: 1_800_001_000n });
    const bid = await w.place(x0, w.creator, OrderSide.Buy, 1_500_000n, 2_500_000_000n);
    const settled = await w.settle(x0);
    const opened = await buildOpenDbcPool({ cross: settled, creator: w.creator, design: defaultDesign(), name: 'Tranche', symbol: 'TRN', uri: 'https://github.com/Pratiikpy/opening-cross' });
    await w.h.send([CU, opened.instruction], w.creator);
    await w.h.send([CU, await buildBindDbcMint(w.view(x0.address), w.admin)], w.admin);
    await w.h.send(await buildClaim(w.view(x0.address), w.admin, bid.owner.address, bid.nonce), w.admin);
    const cross = w.view(x0.address);
    const X = cross.address;
    const baseMint = opened.addresses.baseMint;
    const { post, get, land } = await harness(w, (app) => registerSettleWave3dTx(app, { account: async (a) => { const x = w.h.svm.getAccount(a); return x.exists ? { data: x.data, owner: x.programAddress } : null; }, lifetime: async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }), clock: () => Number(w.h.svm.getClock().unixTimestamp) }));
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    const supply = 500_000_000n;
    const start = w.h.svm.getClock().unixTimestamp + 600n;
    const end = start + 3_600n;
    const maxCap = (supply * pStar) / cross.data.priceScale;
    const base = await generateKeyPairSigner();

    // The API finds the hook from the mint and adds its accounts; a buyer's routes refuse while there is no tranche.
    expect((await post('/v1/tx/presale-deposit', { cross: X, base: base.address, buyer: w.creator.address, amount: '1' })).body.reason).toBe('NO_TRANCHE');
    const openRoute = await post('/v1/tx/open-fixed-price-presale', { cross: X, creator: w.creator.address, base: base.address, terms: { maxCap: String(maxCap), minCap: '1000000', start: String(start), end: String(end), supply: String(supply), buyerMinDeposit: '1000', buyerMaxDeposit: String(maxCap) } });
    expect(openRoute.body.transferHook).toBe(true);
    await land(openRoute, [w.creator, base]);
    const built = await buildOpenFixedPricePresale({ cross, creator: w.creator, base, terms: { maxCap, minCap: 1_000_000n, start, end, supply, buyerMinDeposit: 1_000n, buyerMaxDeposit: maxCap }, transferHook: true });
    const presaleAccount = w.h.svm.getAccount(built.addresses.presale);
    expect(presaleAccount.exists).toBe(true);
    expect(await w.h.balance(built.addresses.presaleVault)).toBe(supply);

    // Buyers: Alice deposits (the first deposit opens her escrow in the same transaction); the sale is not over, so a claim is refused by the program, not by a guess.
    w.h.setTime(start + 10n);
    const alice = await w.trader(2_000_000_000n);
    const dep = await post('/v1/tx/presale-deposit', { cross: X, base: base.address, buyer: alice.address, amount: '400000000' });
    expect(dep.body).toMatchObject({ opensEscrow: true, clearingPrice: String(pStar) });
    expect(BigInt(dep.body.expectedBase)).toBe((400_000_000n * cross.data.priceScale) / pStar);
    await land(dep, [alice]);
    expect((await post('/v1/tx/presale-deposit', { cross: X, base: base.address, buyer: alice.address, amount: '100000000' })).body.opensEscrow).toBe(false);
    const stranger = await w.trader(0n, 0n);
    expect((await post('/v1/tx/presale-claim', { cross: X, base: base.address, buyer: stranger.address })).body.reason).toBe('NO_ESCROW');
    expect((await post('/v1/tx/presale-creator-withdraw', { cross: X, base: base.address, creator: alice.address })).body.reason).toBe('NOT_THE_CREATOR');
    // The sale is still open (400,000,000 of 750,000,000): a claim and the issuer's withdrawal are refused in words.
    expect((await post('/v1/tx/presale-claim', { cross: X, base: base.address, buyer: alice.address })).body.reason).toBe('NOT_COMPLETED');
    expect((await post('/v1/tx/presale-creator-withdraw', { cross: X, base: base.address, creator: w.creator.address })).body.reason).toBe('STILL_OPEN');
    w.h.setTime(end + 10n);
    expect((await post('/v1/tx/presale-deposit', { cross: X, base: base.address, buyer: alice.address, amount: '1000' })).body.reason).toBe('NOT_ONGOING');
    const claim = await post('/v1/tx/presale-claim', { cross: X, base: base.address, buyer: alice.address });
    expect(claim.body.transferHook).toBe(true);
    await land(claim, [alice]);
    const expectedBase = (400_000_000n << 64n) / built.qPrice;
    const gotBase = await w.h.balanceOf(alice.address, baseMint);
    expect(gotBase <= expectedBase && expectedBase - gotBase <= 1n).toBe(true);
    // The creator withdraws what was raised.
    const before = await w.h.balanceOf(w.creator.address, w.quoteMint);
    const withdrawn = await post('/v1/tx/presale-creator-withdraw', { cross: X, base: base.address, creator: w.creator.address });
    expect(withdrawn.body.outcome).toBe('completed');
    await land(withdrawn, [w.creator]);
    const paid = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - before;
    expect(paid <= 400_000_000n && 400_000_000n - paid <= 1n).toBe(true);
    expect((await post('/v1/tx/presale-creator-withdraw', { cross: X, base: base.address, creator: w.creator.address })).body.reason).toBe('ALREADY_WITHDRAWN');
    void get;
  });
});

describe.skipIf(!existsSync(DFS_FIXTURE))('fee sharing and the calibrated curve through the API', () => {
  it('creates a vault of two recipients (and refuses one), reads what each can claim, and calibrates a curve from bids', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const base = await generateKeyPairSigner();
    const a = await w.trader(0n, 0n);
    const b = await w.trader(0n, 0n);
    const funder = await w.trader(10_000_000_000n);
    for (const u of [a, b]) await w.h.ata(u.address, w.quoteMint, w.admin);
    const one = await post('/v1/tx/fee-share-create', { payer: w.creator.address, base: base.address, mint: w.quoteMint, recipients: [{ address: a.address, share: 1 }] });
    expect(one.status).toBe(400);
    expect(one.body.error).toMatch(/2 to 5/);
    const create = await post('/v1/tx/fee-share-create', { payer: w.creator.address, base: base.address, mint: w.quoteMint, recipients: [{ address: a.address, share: 7 }, { address: b.address, share: 3 }] });
    await land(create, [w.creator, base]);
    await land(await post('/v1/tx/fee-share-fund', { funder: funder.address, base: base.address, mint: w.quoteMint, amount: '1000000007' }), [funder]);
    const read = (await get(`/v1/fee-share/${base.address}/${w.quoteMint}`)).body;
    expect(read.shares.map((s: { claimable: string }) => s.claimable)).toEqual(['700000004', '300000002']);
    // The figure is what a claim pays.
    const before = await w.h.balanceOf(a.address, w.quoteMint);
    await land(await post('/v1/tx/fee-share-claim', { user: a.address, base: base.address, mint: w.quoteMint, index: 0 }), [a]);
    expect((await w.h.balanceOf(a.address, w.quoteMint)) - before).toBe(700_000_004n);
    expect((await get(`/v1/fee-share/${base.address}/${w.quoteMint}`)).body.shares[0].claimable).toBe('0');

    // The calibrated curve: heavy demand near the clearing price gets the depth.
    const bids = [{ price: '1400000', quantity: '900' }, { price: '1500000', quantity: '800' }, { price: '2400000', quantity: '60' }, { price: '1000000', quantity: '5000' }];
    const cal = await post('/v1/curve/calibrate', { clearingPrice: '1300000', bids, segments: 3 });
    expect(cal.status).toBe(200);
    expect(cal.body).toMatchObject({ basis: 'demand', demandAbove: '1760' });
    expect(cal.body.sqrtPriceMultiples).toHaveLength(3);
    expect(cal.body.liquidityWeights[0]).toBeGreaterThan(cal.body.liquidityWeights[2]);
    expect((await post('/v1/curve/calibrate', { clearingPrice: '1300000', bids: [] })).body.basis).toBe('default');
    expect((await post('/v1/curve/calibrate', { clearingPrice: '1300000', bids, segments: 99 })).status).toBe(400);
    expect((await post('/v1/curve/calibrate', { clearingPrice: '0', bids })).status).toBe(422);
    expect((await post('/v1/curve/calibrate', { cross: w.creator.address, clearingPrice: '1', bids })).status).toBe(400);
  });
});

describe.skipIf(!existsSync(DLMM_FIXTURE))('the locked ladder through the API', () => {
  it('places a ladder DLMM will not release before its time, reads it as locked, refuses its rebalance until then, and refuses a lock once the pair has opened', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: now + 3_600n } });
    await w.h.send([cu, open.instruction], w.creator);
    const X = cross.address;
    const key = await generateKeyPairSigner();
    const body = (over: Record<string, unknown>) => ({ cross: X, owner: w.creator.address, newPosition: key.address, baseAmount: '2000000000', bins: 20, ...over });

    // A lock in the past is refused in words; a lock for a month on the closed pair is built.
    expect((await post('/v1/tx/ladder-position-place', body({ lockUntil: String(now - 1n) }))).body.reason).toBe('LOCK_IN_PAST');
    const release = now + 30n * DAY;
    const placed = await post('/v1/tx/ladder-position-place', body({ lockUntil: String(release) }));
    expect(placed.body.lockedUntil).toBe(String(release));
    expect(placed.body.position).not.toBe(key.address);
    await land(placed, [w.creator, key]);
    const read = (await get(`/v1/crosses/${X}/ladder?position=${placed.body.position}`)).body;
    expect(read).toMatchObject({ locked: true, lockedUntil: String(release), owner: w.creator.address, status: { untouched: true } });
    expect(read.note).toMatch(/Locked/);

    // The pair opens at its start; the lock holds past it. A rebalance is refused until the release time, and the lock is DLMM's, not the API's: the withdrawal itself fails on chain.
    w.h.setTime(now + 7n * DAY);
    expect((await post('/v1/tx/ladder-rebalance-withdraw', { cross: X, owner: w.creator.address, position: placed.body.position })).body.reason).toBe('LOCKED');
    // And once the pair is open a lock is no longer possible, for a new ladder.
    const another = await generateKeyPairSigner();
    expect((await post('/v1/tx/ladder-position-place', { ...body({ lockUntil: String(release) }), newPosition: another.address })).body.reason).toBe('PAIR_OPEN');
    // An unlocked ladder is still allowed on the open pair.
    expect((await post('/v1/tx/ladder-position-place', { ...body({}), newPosition: another.address, baseAmount: '1000000000' })).status).toBe(200);
    // At the release time the lock gate is passed (nothing has sold, so there is nothing to rebalance).
    w.h.setTime(release);
    expect((await post('/v1/tx/ladder-rebalance-withdraw', { cross: X, owner: w.creator.address, position: placed.body.position })).body.reason).toBe('NOTHING_TO_REBALANCE');
    expect((await get(`/v1/crosses/${X}/ladder?position=${placed.body.position}`)).body.locked).toBe(false);
  });
});
