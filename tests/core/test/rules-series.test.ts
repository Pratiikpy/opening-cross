// Recurring crosses (ADR-0456): a series spawns its crosses by itself, on an interval or on a calendar's sessions,
// re-centres its grid on the last print, runs one cross at a time and pays the dust bond from its own funds.
import { describe, expect, it } from 'vitest';
import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  getCreateCalendarInstruction,
} from '@opening-cross/cross-calendar-client';
import {
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  auxShardIndexes,
  paddedRules,
  getCrossDecoder,
  getInitShardInstruction,
  getSetSeriesActiveInstruction,
  readCrossExt,
  shardAddress,
  type CrossView,
} from '@opening-cross/sdk';
import { buildCreateSeries, buildSpawnNext, viewOfSeries, type SeriesView } from '../src/series-helpers.js';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const DAY = 86_400n;

function seriesConfig(over: Record<string, unknown> = {}) {
  return {
    kind: CrossKind.Recurring,
    disclosure: Disclosure.Open,
    priceScale: 1_000_000n,
    grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 21, tickBps: 100, center: 1_000_000n },
    startTs: T0 + 100n,
    intervalSecs: 1_000n,
    calendar: null,
    callSecs: 100n,
    revealSecs: 0n,
    minMatched: 0n,
    maxImbalanceBps: null,
    integratorFeeBps: 20,
    integrator: null as unknown as Address,
    gateMint: null,
    shards: 2,
    maxOrders: 16,
    proceedsTo: '11111111111111111111111111111111' as Address,
    oracle: null,
    maxCrosses: 0n,
    rules: paddedRules({}),
    ...over,
  };
}

async function setup(over: Record<string, unknown> = {}) {
  const w = await RulesWorld.createRules();
  const cfg = seriesConfig({ integrator: w.integrator.address, ...over });
  const { series, instructions } = await buildCreateSeries({
    authority: w.creator,
    seriesId: 1n,
    baseMint: w.baseMint,
    quoteMint: w.quoteMint,
    baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    config: cfg as never,
  });
  await w.h.send(instructions, w.creator);
  // The series pays the dust bond of each cross from its quote account.
  await w.h.fund(w.quoteMint, w.admin, series, 100_000_000_000n);
  const view = (): SeriesView => {
    const a = w.h.svm.getAccount(series);
    if (!a.exists) throw new Error('series missing');
    return viewOfSeries(series, a.data);
  };
  return { w, series, view };
}

async function spawn(w: RulesWorld, sv: SeriesView): Promise<CrossView> {
  const { cross, instruction } = await buildSpawnNext(sv, w.admin);
  await w.h.send([instruction], w.admin);
  const acc = w.h.svm.getAccount(cross);
  if (!acc.exists) throw new Error('spawned cross missing');
  const v: CrossView = { address: cross, data: getCrossDecoder().decode(acc.data) };
  const ext = readCrossExt(acc.data);
  const indexes = [...Array.from({ length: Number(v.data.shards) }, (_, i) => i), ...auxShardIndexes(ext, Number(v.data.shards))];
  for (const index of indexes) {
    const shard = await shardAddress(cross, index);
    if (!w.h.svm.getAccount(shard).exists) await w.h.send([getInitShardInstruction({ payer: w.admin, cross, shard, index })], w.admin);
  }
  return v;
}

describe('recurring series on an interval', () => {
  it('spawns, trades, settles, re-centres on the print and spawns again', async () => {
    const { w, series, view } = await setup();
    w.h.setTime(T0 + 10n);
    const first = await spawn(w, view());
    expect(first.data.creator).toBe(series);
    expect(first.data.closeTs).toBe(T0 + 100n);
    expect(first.data.openTs).toBe(T0);
    // Grid: centre 1.0, ticks of 1%, 21 of them (10 below, 10 above).
    expect(first.data.tick).toBe(10_000n);
    expect(first.data.minPrice).toBe(900_000n);
    expect(first.data.referencePrice.__option === 'Some' ? first.data.referencePrice.value : 0n).toBe(1_000_000n);
    // The dust bond came out of the series' funds.
    expect(first.data.dustBond > 0n).toBe(true);

    const seller = await w.trader(0n, 5_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const orders = [
      await w.place(first, seller, OrderSide.Sell, 1_040_000n, 100_000_000n),
      await w.place(first, buyer, OrderSide.Buy, 1_060_000n, 100_000_000n),
    ];
    const settled = await w.settle(first);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const printed = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n;
    await w.claimAll(settled, orders);
    const final = await w.finalize(settled);
    expect(final.data.state).toBe(CrossState.Finalized);

    // The second cross is centred on the last print, with ticks of 1% of it.
    w.h.setTime(T0 + 1_000n);
    const second = await spawn(w, view());
    expect(view().data.lastPrice).toBe(printed);
    expect(second.data.closeTs).toBe(T0 + 1_100n);
    expect(second.data.tick).toBe((printed * 100n) / 10_000n);
    expect(second.data.minPrice).toBe(printed - 10n * second.data.tick);
    expect(view().data.nextIndex).toBe(2n);
    expect(view().data.lastCross).toEqual({ __option: 'Some', value: second.address });
  });

  it('runs one cross at a time, and not before it is due', async () => {
    const { w, view } = await setup();
    // Far too early: the first call opens at T0, so nothing may be spawned a month ahead.
    w.h.setTime(T0 - 30n * DAY);
    const early = await buildSpawnNext(view(), w.admin);
    expect(await w.h.fail([early.instruction], w.admin)).toMatch(/SpawnTooEarly|InvalidTimeline/);
    w.h.setTime(T0 + 10n);
    await spawn(w, view());
    // The previous cross is still live: no second one.
    w.h.setTime(T0 + 20n);
    const second = await buildSpawnNext(view(), w.admin);
    expect(await w.h.fail([second.instruction], w.admin)).toMatch(/SeriesPreviousMissing/);
  });

  it('the authority pauses it, and only the authority', async () => {
    const { w, series, view } = await setup();
    const stranger = await w.trader();
    expect(await w.h.fail([getSetSeriesActiveInstruction({ authority: stranger, series, active: false })], stranger)).toMatch(/Unauthorized/);
    await w.h.send([getSetSeriesActiveInstruction({ authority: w.creator, series, active: false })], w.creator);
    w.h.setTime(T0 + 10n);
    const s = await buildSpawnNext(view(), w.admin);
    expect(await w.h.fail([s.instruction], w.admin)).toMatch(/SeriesInactive/);
  });

  it('stops after its last cross', async () => {
    const { w, view } = await setup({ maxCrosses: 1n });
    w.h.setTime(T0 + 10n);
    const first = await spawn(w, view());
    const settled = await w.settle(first);
    await w.finalize(settled).catch(() => undefined);
    w.h.setTime(T0 + 5_000n);
    const next = await buildSpawnNext(view(), w.admin);
    expect(await w.h.fail([next.instruction], w.admin)).toMatch(/SeriesInactive|SeriesPreviousMissing/);
  });
});

describe('recurring series on a calendar', () => {
  it('closes each cross at the next session start', async () => {
    const w = await RulesWorld.createRules();
    const id8 = new Uint8Array(8);
    new DataView(id8.buffer).setBigUint64(0, 1n, true);
    const cal = (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(w.admin.address), id8] }))[0];
    const sessions = [T0 + 500n, T0 + 2_000n, T0 + 5_000n].map((s) => ({ startTs: s, endTs: s + 600n }));
    await w.h.send([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 1n, timelockSecs: 7n * DAY, sessions, feeds: [] })], w.admin);
    const cfg = seriesConfig({ integrator: w.integrator.address, intervalSecs: 0n, startTs: 0n, calendar: cal, callSecs: 200n });
    const { series, instructions } = await buildCreateSeries({ authority: w.creator, seriesId: 1n, baseMint: w.baseMint, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, config: cfg as never });
    await w.h.send(instructions, w.creator);
    await w.h.fund(w.quoteMint, w.admin, series, 100_000_000_000n);
    const read = (): SeriesView => {
      const a = w.h.svm.getAccount(series);
      if (!a.exists) throw new Error('series');
      return viewOfSeries(series, a.data);
    };
    w.h.setTime(T0 + 400n);
    const first = await spawn(w, read());
    expect(first.data.closeTs).toBe(T0 + 500n);
    expect(first.data.calendar.__option === 'Some' ? first.data.calendar.value : null).toBe(cal);
    const settled = await w.settle(first);
    await w.finalize(settled);
    w.h.setTime(T0 + 1_900n);
    const second = await spawn(w, read());
    expect(second.data.closeTs).toBe(T0 + 2_000n);
  });
});
