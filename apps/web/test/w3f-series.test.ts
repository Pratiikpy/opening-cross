import { describe, expect, it } from 'vitest';
import { EMPTY_SERIES_FORM, SPAWN_LEAD_SECS, type SeriesForm, type SeriesRead, buildSeries, countText, lastCloseTs, nextCloseTs, scheduleText, seriesStatus, seriesSummary, spawnVerdict } from '../src/lib/series';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const base = { decimals: 6, program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };
const quote = { decimals: 6, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
const HOUR = 3600;
const DAY = 86_400;

const series = (o: Partial<SeriesRead> = {}): SeriesRead => ({
  series: C,
  authority: A,
  seriesId: '1',
  baseMint: A,
  quoteMint: B,
  active: true,
  next: '0',
  maxCrosses: null,
  lastCross: null,
  lastPrice: null,
  schedule: { startTs: String(1_000_000), intervalSecs: String(7 * DAY) },
  callSecs: String(2 * HOUR),
  revealSecs: '0',
  crosses: [],
  ...o,
});

describe('nextCloseTs mirrors the program', () => {
  it('uses the first slot when it is still ahead', () => {
    expect(nextCloseTs(series(), 900_000, null)).toBe(1_000_000);
  });
  it('skips slots that were missed and takes the first strictly after now', () => {
    const now = 1_000_000 + 2 * 7 * DAY + 5;
    expect(nextCloseTs(series({ next: '1' }), now, null)).toBe(1_000_000 + 3 * 7 * DAY);
  });
  it('never closes before the previous cross closed', () => {
    const s = series({ next: '1', crosses: [{ idx: '0', cross_address: B, close_ts: String(1_000_000 + 7 * DAY) }] });
    // now is before the last close: the floor is the last close, so the next slot is after it
    expect(nextCloseTs(s, 1_000_000, null)).toBe(1_000_000 + 7 * DAY + 7 * DAY);
  });
  it('an exact slot boundary is not "ahead": the following slot is taken', () => {
    expect(nextCloseTs(series(), 1_000_000, null)).toBe(1_000_000 + 7 * DAY);
  });
  it('on a calendar takes the earliest session start after the floor, or nothing', () => {
    const s = series({ schedule: { calendar: B } });
    expect(nextCloseTs(s, 100, [500, 300, 200])).toBe(200);
    expect(nextCloseTs(s, 400, [500, 300, 200])).toBe(500);
    expect(nextCloseTs(s, 600, [500, 300, 200])).toBeNull();
    expect(nextCloseTs(s, 100, null)).toBeNull();
  });
  it('reads the latest cross by index, not by list order', () => {
    const s = series({ crosses: [{ idx: '1', cross_address: A, close_ts: '50' }, { idx: '2', cross_address: B, close_ts: '90' }, { idx: '0', cross_address: C, close_ts: '10' }] });
    expect(lastCloseTs(s)).toBe(90);
  });
});

describe('spawnVerdict', () => {
  const soon = 1_000_000 - 2 * HOUR - 3600; // the first call opens in an hour
  it('allows a spawn when the cross opens within 24 hours', () => {
    const v = spawnVerdict(series(), soon, null, null);
    expect(v).toEqual({ can: true, closeTs: 1_000_000, opensAt: 1_000_000 - 2 * HOUR });
  });
  it('refuses one that is more than 24 hours early, and says when it can run', () => {
    const now = 1_000_000 - 2 * HOUR - SPAWN_LEAD_SECS - 100;
    const v = spawnVerdict(series(), now, null, null);
    expect(v.can).toBe(false);
    if (!v.can) {
      expect(v.code).toBe('too-early');
      expect(v.spawnableFrom).toBe(1_000_000 - 2 * HOUR - SPAWN_LEAD_SECS);
    }
  });
  it('runs one cross at a time', () => {
    const s = series({ next: '1', lastCross: B });
    expect(spawnVerdict(s, soon, 'Live', null)).toMatchObject({ can: false, code: 'previous-live' });
    expect(spawnVerdict(s, soon, null, null)).toMatchObject({ can: false, code: 'previous-unknown' });
    expect(spawnVerdict(s, 1_000_000 + 7 * DAY - 3 * HOUR, 'NoPrint', null).can).toBe(true);
    expect(spawnVerdict(s, 1_000_000 + 7 * DAY - 3 * HOUR, 'Finalized', null).can).toBe(true);
  });
  it('refuses a paused series and one that ran its last cross', () => {
    expect(spawnVerdict(series({ active: false }), soon, null, null)).toMatchObject({ can: false, code: 'paused' });
    expect(spawnVerdict(series({ next: '3', maxCrosses: '3' }), soon, 'Finalized', null)).toMatchObject({ can: false, code: 'done' });
    expect(spawnVerdict(series({ next: '2', maxCrosses: '3' }), 1_000_000 + 14 * DAY - 3 * HOUR, 'Finalized', null).can).toBe(true);
  });
  it('on a calendar says so when the sessions are unknown or none is ahead', () => {
    const s = series({ schedule: { calendar: B } });
    expect(spawnVerdict(s, 100, null, null)).toMatchObject({ can: false, code: 'unknown-calendar' });
    expect(spawnVerdict(s, 100, null, [50])).toMatchObject({ can: false, code: 'no-session' });
    expect(spawnVerdict(s, 100, null, [100 + 2 * HOUR + 60]).can).toBe(true);
  });
});

describe('status and text', () => {
  it('names the state in one word', () => {
    expect(seriesStatus(series({ active: false }), null)).toBe('paused');
    expect(seriesStatus(series({ next: '2', maxCrosses: '2' }), 'Finalized')).toBe('done');
    expect(seriesStatus(series({ next: '1' }), 'Live')).toBe('running');
    expect(seriesStatus(series(), null)).toBe('waiting');
  });
  it('states the schedule and the count in words', () => {
    expect(scheduleText(series())).toBe('One cross every 7 days, from 1970-01-12 13:46 UTC');
    expect(scheduleText(series({ schedule: { startTs: '1000000', intervalSecs: '21600' } }))).toMatch(/every 6 hours/);
    expect(scheduleText(series({ schedule: { calendar: B } }))).toMatch(/each session of the calendar/);
    expect(countText(series({ next: '2', maxCrosses: '5' }))).toBe('2 of 5 spawned');
    expect(countText(series({ next: '4' }))).toBe('4 spawned, no limit');
  });
});

const form = (o: Partial<SeriesForm>): SeriesForm => ({ ...EMPTY_SERIES_FORM, baseMint: A, quoteMint: B, startAt: '2026-11-02T12:00', centerPrice: '1.5', integrator: C, proceedsTo: C, ...o });
const ctx = { authority: A, base, quote };

describe('buildSeries', () => {
  it('builds a weekly relative-grid series as the API takes it', () => {
    const b = buildSeries(form({}), ctx);
    expect(b.errors).toEqual({});
    expect(b.body).toEqual({
      authority: A,
      seriesId: '1',
      baseMint: A,
      quoteMint: B,
      baseTokenProgram: base.program,
      quoteTokenProgram: quote.program,
      config: {
        kind: 'recurring',
        disclosure: 'open',
        priceScale: '1000000',
        grid: { relative: true, minPrice: '0', tick: '0', ticks: 41, tickBps: 100, center: '1500000' },
        startTs: Math.floor(new Date('2026-11-02T12:00').getTime() / 1000),
        intervalSecs: 604_800,
        callSecs: 7200,
        revealSecs: 0,
        minMatched: '0',
        integratorFeeBps: 0,
        integrator: C,
        shards: 4,
        maxOrders: 10_000,
        proceedsTo: C,
        maxCrosses: '0',
      },
    });
  });
  it('builds a sealed series on a calendar with a fixed grid, a limit and a cap on crosses', () => {
    const b = buildSeries(form({ disclosure: 'sealed', revealMins: '15', schedule: 'calendar', calendar: B, gridMode: 'fixed', minPrice: '0.5', tick: '0.05', ticks: '60', maxCrosses: '12', minMatched: '1000', maxImbalancePct: '25', gateMint: C, integratorFeePct: '0.2' }), ctx);
    expect(b.errors).toEqual({});
    const c = b.body!.config as Record<string, unknown>;
    expect(c).toMatchObject({ disclosure: 'sealed', revealSecs: 900, calendar: B, intervalSecs: 0, startTs: 0, grid: { relative: false, minPrice: '500000', tick: '50000', ticks: 60, tickBps: 0, center: '0' }, maxCrosses: '12', minMatched: '1000000000', maxImbalanceBps: 2500, gateMint: C, integratorFeeBps: 20 });
  });
  it('carries the hard-to-game ending as rules, and needs a call longer than an hour', () => {
    const ok = buildSeries(form({ rules: 'ending', callMins: '180' }), ctx);
    expect(ok.errors).toEqual({});
    expect((ok.body!.config as { rules: { ending: Record<string, unknown> } }).rules.ending).toMatchObject({ endingSecs: 1800, buckets: 6, cancelCutoffSecs: 1800, randomEnd: true });
    expect(buildSeries(form({ rules: 'ending', callMins: '60' }), ctx).errors.callMins).toMatch(/longer than an hour/);
  });
  it('names every field it cannot read and sends nothing', () => {
    const b = buildSeries(form({ seriesId: 'x', baseMint: 'nope', callMins: '0', intervalHours: '1.5', startAt: '', ticks: '1', tickPct: '0', centerPrice: '0', integratorFeePct: '9', shards: '99', maxOrders: '0', maxCrosses: '0', gateMint: 'zzz' }), ctx);
    expect(Object.keys(b.errors).sort()).toEqual(['baseMint', 'callMins', 'centerPrice', 'gateMint', 'integratorFeePct', 'intervalHours', 'maxCrosses', 'maxOrders', 'seriesId', 'shards', 'startAt', 'tickPct', 'ticks']);
    expect(b.body).toBeNull();
  });
  it('enforces the program’s own rules before the wallet is asked', () => {
    expect(buildSeries(form({ disclosure: 'sealed', revealMins: '' }), ctx).errors.revealMins).toMatch(/reveal window/);
    expect(buildSeries(form({ disclosure: 'open', revealMins: '10' }), ctx).errors.revealMins).toMatch(/open call has no reveal/);
    expect(buildSeries(form({ intervalHours: '1', callMins: '90' }), ctx).errors.callMins).toMatch(/shorter than the interval/);
    expect(buildSeries(form({ schedule: 'calendar', calendar: '' }), ctx).errors.calendar).toMatch(/required/);
    expect(buildSeries(form({ quoteMint: A }), ctx).errors.quoteMint).toMatch(/differ/);
  });
  it('refuses a price that would round, and a token it could not read', () => {
    expect(buildSeries(form({ centerPrice: '1.0000001' }), ctx).errors.centerPrice).toMatch(/6 decimal places/);
    expect(buildSeries(form({}), { authority: A, base: null, quote }).errors.baseMint).toMatch(/could read/);
  });
  it('gives no body while no wallet is connected', () => {
    const b = buildSeries(form({}), { ...ctx, authority: null });
    expect(b.body).toBeNull();
    expect(b.errors).toEqual({});
  });
  it('summarises what is committed, from the body', () => {
    const b = buildSeries(form({ maxCrosses: '4' }), ctx);
    const lines = seriesSummary(b.body!, { base, quote });
    expect(lines.join(' ')).toMatch(/every 7 days/);
    expect(lines.join(' ')).toMatch(/41 steps of 1% of the last price, centred on 1.5/);
    expect(lines.join(' ')).toMatch(/stops after 4 crosses/);
    expect(lines.join(' ')).toMatch(/Only the authority can pause/);
  });
});
