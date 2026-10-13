// A stock's week through the cross (ADR-0462): a halted asset, the resume cross that lifts the halt and feeds lenders,
// the next scheduled reopen on the calendar with pegged-to-open orders, and an unlock sold in the open.
import { describe, expect, it } from 'vitest';
import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_CALENDAR_PROGRAM_ADDRESS, getCreateCalendarInstruction } from '@opening-cross/cross-calendar-client';
import {
  CrossKind,
  CrossState,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_RESUMES_HALT,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  auxShardIndexes,
  paddedRules,
  getCrossDecoder,
  getHaltStateDecoder,
  getInitHaltStateInstruction,
  getInitPrintFeedInstruction,
  getInitShardInstruction,
  getPrintFeedDecoder,
  getSetHaltInstruction,
  haltStateAddress,
  peggedOrder,
  printFeedAddress,
  protocolAddress,
  readCrossExt,
  shardAddress,
} from '@opening-cross/sdk';
import { buildCreateSeries, buildSpawnNext, viewOfSeries } from '../src/series-helpers.js';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const DAY = 86_400n;

describe('a halted stock reopens through a cross', () => {
  it('the scheduled reopen does not print while the asset is halted; the issuer\'s resume cross prints, lifts the halt and feeds lenders; the next reopen prints', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltStateAddress(w.baseMint);
    await w.h.send([getInitHaltStateInstruction({ authority: w.admin, baseMint: w.baseMint, protocol: await protocolAddress(), halt, venueSigner: null, breaker: null })], w.admin);
    const feed = await printFeedAddress(w.baseMint);
    await w.h.send([getInitPrintFeedInstruction({ authority: w.admin, baseMint: w.baseMint, quoteMint: w.quoteMint, protocol: await protocolAddress(), feed, publishers: [w.admin.address], minMatched: 50_000_000n })], w.admin);

    // The calendar: three scheduled opens.
    const id8 = new Uint8Array(8);
    new DataView(id8.buffer).setBigUint64(0, 1n, true);
    const cal = (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(w.admin.address), id8] }))[0];
    const sessions = [T0 + 500n, T0 + 3_000n, T0 + 6_000n].map((s) => ({ startTs: s, endTs: s + 600n }));
    await w.h.send([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 1n, timelockSecs: 7n * DAY, sessions, feeds: [] })], w.admin);

    // A series of reopens on the calendar, every one guarded by the asset's halt state.
    const config = {
      kind: CrossKind.Reopen,
      disclosure: Disclosure.Open,
      priceScale: 1_000_000n,
      grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 21, tickBps: 100, center: 1_500_000n },
      startTs: 0n,
      intervalSecs: 0n,
      calendar: cal,
      callSecs: 200n,
      revealSecs: 0n,
      minMatched: 0n,
      maxImbalanceBps: null,
      integratorFeeBps: 20,
      integrator: w.integrator.address,
      gateMint: null,
      shards: 2,
      maxOrders: 16,
      proceedsTo: '11111111111111111111111111111111' as Address,
      oracle: null,
      maxCrosses: 0n,
      rules: paddedRules({ guards: { haltSource: halt } }),
    };
    const { series, instructions } = await buildCreateSeries({ authority: w.creator, seriesId: 1n, baseMint: w.baseMint, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, config: config as never });
    await w.h.send(instructions, w.creator);
    await w.h.fund(w.quoteMint, w.admin, series, 100_000_000_000n);
    const seriesView = () => {
      const a = w.h.svm.getAccount(series);
      if (!a.exists) throw new Error('series missing');
      return viewOfSeries(series, a.data);
    };
    const spawn = async () => {
      const { cross, instruction } = await buildSpawnNext(seriesView(), w.admin);
      await w.h.send([instruction], w.admin);
      const acc = w.h.svm.getAccount(cross);
      if (!acc.exists) throw new Error('spawned cross missing');
      const data = getCrossDecoder().decode(acc.data);
      for (const index of [...Array.from({ length: data.shards }, (_, i) => i), ...auxShardIndexes(readCrossExt(acc.data), data.shards)]) {
        await w.h.send([getInitShardInstruction({ payer: w.admin, cross, shard: await shardAddress(cross, index), index })], w.admin);
      }
      return w.view(cross);
    };

    // Week 1: the issuer has halted the asset.
    await w.h.send([getSetHaltInstruction({ signer: w.admin, halt })], w.admin);
    w.h.setTime(T0 + 400n);
    const first = await spawn();
    expect(first.data.closeTs).toBe(T0 + 500n);
    const grid = { minPrice: first.data.minPrice, tick: first.data.tick, ticks: first.data.ticks, priceScale: first.data.priceScale };
    const holder1 = await w.trader(0n, 500_000_000n);
    const buyer1 = await w.trader(5_000_000_000n);
    // The holder sells at the open, whatever it prints (pegged), and a buyer buys at the open.
    const sell = peggedOrder(grid, OrderSide.Sell, 100_000_000n);
    const buy = peggedOrder(grid, OrderSide.Buy, 100_000_000n);
    const o1 = [await w.place(first, holder1, OrderSide.Sell, sell.price, sell.quantity, { escrow: sell.escrow }), await w.place(first, buyer1, OrderSide.Buy, buy.price, buy.quantity, { escrow: buy.escrow })];
    const settled1 = await w.settle(first);
    expect(settled1.data.state).toBe(CrossState.NoPrint);
    expect(settled1.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.Halted });
    await w.claimAll(settled1, o1);
    expect(await w.h.balanceOf(holder1.address, w.baseMint)).toBe(500_000_000n);
    expect(await w.h.balanceOf(buyer1.address, w.quoteMint)).toBe(5_000_000_000n);

    // The issuer (the halt state's authority, here the admin) runs a resume cross: it prints, lifts the halt, feeds lenders.
    w.creator = w.admin;
    await w.h.ata(w.admin.address, w.baseMint, w.admin);
    await w.h.ata(w.admin.address, w.quoteMint, w.admin);
    await w.h.fund(w.quoteMint, w.admin, w.admin.address, 1_000_000_000_000n);
    w.h.setTime(T0 + 1_000n);
    const resume = await w.newRuledCross({ reference: 1_500_000n, openTs: T0 + 1_000n, closeTs: T0 + 1_100n, rules: { flags: FLAG_RESUMES_HALT | FLAG_FEEDS_LENDERS, guards: { haltSource: halt } } });
    const holder2 = await w.trader(0n, 500_000_000n);
    const buyer2 = await w.trader(5_000_000_000n);
    const o2 = [await w.place(resume, holder2, OrderSide.Sell, 1_400_000n, 100_000_000n), await w.place(resume, buyer2, OrderSide.Buy, 1_600_000n, 100_000_000n)];
    const settled2 = await w.settle(resume);
    expect(settled2.data.state).toBe(CrossState.Cleared);
    const decodedHalt = () => {
      const a = w.h.svm.getAccount(halt);
      if (!a.exists) throw new Error('halt state missing');
      return getHaltStateDecoder().decode(a.data);
    };
    expect(decodedHalt().halted).toBe(false);
    const f = w.h.svm.getAccount(feed);
    if (!f.exists) throw new Error('feed missing');
    const feedState = getPrintFeedDecoder().decode(f.data);
    expect(feedState.prints).toBe(1n);
    expect(feedState.cross).toBe(resume.address);
    await w.claimAll(settled2, o2);
    const printed = settled2.data.clearing.__option === 'Some' ? settled2.data.clearing.value.price : 0n;
    expect(feedState.price).toBe(printed);

    // Week 2: the scheduled reopen, no longer halted, prints; pegged orders fill at the open and pay only the open.
    w.h.setTime(T0 + 2_900n);
    const second = await spawn();
    expect(second.data.closeTs).toBe(T0 + 3_000n);
    const grid2 = { minPrice: second.data.minPrice, tick: second.data.tick, ticks: second.data.ticks, priceScale: second.data.priceScale };
    const holder3 = await w.trader(0n, 500_000_000n);
    const buyer3 = await w.trader(5_000_000_000n);
    const s3 = peggedOrder(grid2, OrderSide.Sell, 100_000_000n);
    const b3 = peggedOrder(grid2, OrderSide.Buy, 100_000_000n);
    const o3 = [await w.place(second, holder3, OrderSide.Sell, s3.price, s3.quantity, { escrow: s3.escrow }), await w.place(second, buyer3, OrderSide.Buy, b3.price, b3.quantity, { escrow: b3.escrow })];
    const settled3 = await w.settle(second);
    expect(settled3.data.state).toBe(CrossState.Cleared);
    const open = settled3.data.clearing.__option === 'Some' ? settled3.data.clearing.value.price : 0n;
    await w.claimAll(settled3, o3);
    // The buyer escrowed for the top of the grid and paid only the open; the excess came back.
    expect(await w.h.balanceOf(buyer3.address, w.baseMint)).toBe(100_000_000n);
    expect(5_000_000_000n - (await w.h.balanceOf(buyer3.address, w.quoteMint))).toBe((100_000_000n * open + 999_999n) / 1_000_000n);
  });
});

describe('an unlock sold in the open', () => {
  it('an insider\'s locked fill vests, is released, and is sold into the next reopen cross', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const launch = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule: [{ price: 1_000_000n, quantity: 100_000_000n }], rules: { neutrality: { insiders: [insider.address], insiderCliffSecs: 1_000 } } });
    const order = await w.place(launch, insider, OrderSide.Buy, 1_000_000n, 40_000_000n);
    const settled = await w.settle(launch);
    await w.claimAll(settled, [order]);
    const base = settled.data.baseMint;
    expect(await w.h.balanceOf(insider.address, base)).toBe(0n);
    // Before the cliff nothing can be released; after it the insider holds the tokens and sells them in a reopen of the same mint.
    await expect(w.h.send(await w.releaseIxs(w.view(settled.address), w.admin, insider.address, order.nonce), w.admin)).rejects.toThrow(/NothingToRelease/);
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 1_001n);
    await w.h.send(await w.releaseIxs(w.view(settled.address), w.admin, insider.address, order.nonce), w.admin);
    expect(await w.h.balanceOf(insider.address, base)).toBe(40_000_000n);

    w.baseMint = base;
    for (const who of [w.feeRecipient, w.integrator, w.creator]) await w.h.ata(who.address, base, w.admin);
    const reopen = await w.newRuledCross({ reference: 1_200_000n });
    const buyer = await w.h.wallet();
    await w.h.fund(w.quoteMint, w.admin, buyer.address, 5_000_000_000n);
    await w.h.ata(buyer.address, base, w.admin);
    const sold = await w.place(reopen, insider, OrderSide.Sell, 1_100_000n, 40_000_000n);
    const bought = await w.place(reopen, buyer, OrderSide.Buy, 1_300_000n, 40_000_000n);
    const done = await w.settle(reopen);
    expect(done.data.state).toBe(CrossState.Cleared);
    await w.claimAll(done, [sold, bought]);
    expect(await w.h.balanceOf(buyer.address, base)).toBe(40_000_000n);
    expect((await w.h.balanceOf(insider.address, w.quoteMint)) > 100_000_000_000n - 40_000_000n).toBe(true);
  });
});

describe('a tender', () => {
  it('only listed holders can offer, the issuer\'s bid takes the cheapest offers first and the rest is returned', async () => {
    const { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } = await import('@opening-cross/cross-gate-client');
    const { gatePassAddress } = await import('@opening-cross/sdk');
    const w = await RulesWorld.createRules();
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    const holders = [await w.trader(0n, 400_000_000n), await w.trader(0n, 400_000_000n), await w.trader(0n, 400_000_000n)];
    const outsider = await w.trader(0n, 400_000_000n);
    for (const h of holders) await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, h.address), owner: h.address })], w.admin);
    const issuer = await w.trader(10_000_000_000n);
    await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, issuer.address), owner: issuer.address })], w.admin);
    const cross = await w.newRuledCross({ kind: CrossKind.Tender, gateMint, reference: 1_500_000n });
    // Offers at 1.2, 1.4 and 1.6; the issuer will pay up to 1.5 for 500 tokens.
    const offers = [
      await w.place(cross, holders[0]!, OrderSide.Sell, 1_200_000n, 300_000_000n),
      await w.place(cross, holders[1]!, OrderSide.Sell, 1_400_000n, 300_000_000n),
      await w.place(cross, holders[2]!, OrderSide.Sell, 1_600_000n, 300_000_000n),
    ];
    await expect(w.place(cross, outsider, OrderSide.Sell, 1_200_000n, 100_000_000n)).rejects.toThrow(/NotEligible|AccountNotInitialized|3012/);
    const bid = await w.place(cross, issuer, OrderSide.Buy, 1_500_000n, 500_000_000n);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const price = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n;
    expect(price <= 1_500_000n && price >= 1_400_000n).toBe(true);
    await w.claimAll(settled, [...offers, bid]);
    // The issuer bought 500 tokens in all; the 1.6 offer, above its limit, came home untouched.
    expect(await w.h.balanceOf(issuer.address, w.baseMint)).toBe(500_000_000n);
    expect(await w.h.balanceOf(holders[2]!.address, w.baseMint)).toBe(400_000_000n);
    expect(await w.h.balanceOf(holders[0]!.address, w.baseMint)).toBe(100_000_000n);
  });
});
