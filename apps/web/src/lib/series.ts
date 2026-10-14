// Recurring series (Y1, X1): what GET /v1/series serves, when the next cross of a series can be spawned, and the creation form turned into the
// body of POST /v1/tx/create-series. Pure and free of React so every rule is unit-tested.
//
// The scheduling rules below mirror programs/cross_core/src/series.rs (`next_close`, `spawn_next`): the program, not the caller, decides the close
// of the next cross, a cross is spawned at most 24 hours before it opens, crosses run one at a time, and a missed interval slot is skipped. The
// page states what the program will do; the program remains the authority, and the pre-sign dry run catches any difference.
import { isAddress } from '@solana/kit';
import { EMPTY_RULES_FORM, applyRulePreset, rulePreset } from '@opening-cross/presets/rules';
import { type RulesJson, buildRules } from './issuer-rules';
import { type Market, formatAtoms, parseAtoms, parsePrice, shortAddress } from './units';

export const SPAWN_LEAD_SECS = 86_400;

/** The API sends 64-bit integers as decimal strings; a number is also read. */
export type Big = string | number;

export type SeriesRead = {
  series: string;
  authority: string;
  seriesId: Big;
  baseMint: string;
  quoteMint: string;
  active: boolean;
  next: Big;
  maxCrosses: Big | null;
  lastCross: string | null;
  lastPrice: Big | null;
  schedule: { calendar: string } | { startTs: Big; intervalSecs: Big };
  callSecs: Big;
  revealSecs: Big;
  crosses: { idx: Big; cross_address: string; close_ts: Big }[];
};

export type SeriesListRow = { address: string; authority: string; created_slot: Big; crosses: number };

export type CrossStateName = 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';

const big = (v: Big | null | undefined): bigint | null => {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
};
export const asNumber = (v: Big | null | undefined): number | null => {
  const b = big(v);
  return b === null ? null : Number(b);
};

export const isCalendar = (s: SeriesRead): s is SeriesRead & { schedule: { calendar: string } } => 'calendar' in s.schedule;

/** The close of the most recent cross the index saw for this series (0 when none has been spawned). */
export function lastCloseTs(s: SeriesRead): number {
  let best = -1n;
  let ts = 0;
  for (const c of s.crosses) {
    const i = big(c.idx);
    if (i !== null && i > best) {
      best = i;
      ts = asNumber(c.close_ts) ?? 0;
    }
  }
  return ts;
}

/** The close time the program will give the next cross (`next_close`), or null when it cannot be known: a calendar with no session ahead, or no schedule. */
export function nextCloseTs(s: SeriesRead, now: number, sessionStarts: number[] | null): number | null {
  const floor = Math.max(now, lastCloseTs(s));
  if (!isCalendar(s)) {
    const sched = s.schedule as { startTs: Big; intervalSecs: Big };
    const start = asNumber(sched.startTs);
    const every = asNumber(sched.intervalSecs);
    const index = asNumber(s.next);
    if (start === null || every === null || every <= 0 || index === null) return null;
    const first = start + index * every;
    if (first > floor) return first;
    return first + (Math.floor((floor - first) / every) + 1) * every;
  }
  if (sessionStarts === null) return null;
  const ahead = sessionStarts.filter((t) => t > floor);
  return ahead.length === 0 ? null : Math.min(...ahead);
}

export type SpawnVerdict =
  | { can: true; closeTs: number; opensAt: number }
  | { can: false; code: 'paused' | 'done' | 'previous-unknown' | 'previous-live' | 'no-session' | 'too-early' | 'unknown-calendar'; message: string; closeTs?: number; opensAt?: number; spawnableFrom?: number };

/** Whether `spawn_next` would be accepted now, and if not, the program's reason in words. `previous` is the state of the last spawned cross. */
export function spawnVerdict(s: SeriesRead, now: number, previous: CrossStateName | null, sessionStarts: number[] | null): SpawnVerdict {
  if (!s.active) return { can: false, code: 'paused', message: 'The series is paused. Its authority has to resume it before another cross can be spawned.' };
  const max = big(s.maxCrosses);
  const next = big(s.next) ?? 0n;
  if (max !== null && max > 0n && next >= max) return { can: false, code: 'done', message: `This series has run its last cross (${max.toString()} of ${max.toString()}).` };
  if (next > 0n) {
    if (previous === null) return { can: false, code: 'previous-unknown', message: 'The state of the previous cross could not be read, so this page cannot say whether the next one may start.' };
    if (previous === 'Live') return { can: false, code: 'previous-live', message: 'The previous cross has not settled yet. A series runs one cross at a time; the next can be spawned once it has cleared or failed.' };
  }
  const closeTs = nextCloseTs(s, now, sessionStarts);
  if (closeTs === null) {
    return isCalendar(s)
      ? { can: false, code: sessionStarts === null ? 'unknown-calendar' : 'no-session', message: sessionStarts === null ? 'The calendar this series follows could not be read, so the next session is unknown.' : 'The calendar this series follows has no session ahead. The next cross can be spawned once it publishes one.' }
      : { can: false, code: 'unknown-calendar', message: 'The schedule of this series could not be read.' };
  }
  const call = asNumber(s.callSecs) ?? 0;
  const opensAt = closeTs - call;
  if (now + SPAWN_LEAD_SECS < opensAt) {
    return { can: false, code: 'too-early', message: 'It is too early: a cross is spawned at most 24 hours before it opens, so a series does not lock rent in crosses that are weeks away.', closeTs, opensAt, spawnableFrom: opensAt - SPAWN_LEAD_SECS };
  }
  return { can: true, closeTs, opensAt };
}

export type SeriesStatus = 'running' | 'waiting' | 'paused' | 'done';
/** One word for the state of a series: paused by its authority, finished its last cross, waiting for a cross to settle or for the next slot, or running. */
export function seriesStatus(s: SeriesRead, previous: CrossStateName | null): SeriesStatus {
  if (!s.active) return 'paused';
  const max = big(s.maxCrosses);
  if (max !== null && max > 0n && (big(s.next) ?? 0n) >= max) return 'done';
  if (previous === 'Live') return 'running';
  return 'waiting';
}

/** An interval in the largest whole unit that divides it: "7 days", "6 hours", "90 minutes". */
export function everyText(secs: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (secs % 86_400 === 0) return unit(secs / 86_400, 'day');
  if (secs % 3_600 === 0) return unit(secs / 3_600, 'hour');
  if (secs % 60 === 0) return unit(secs / 60, 'minute');
  return unit(secs, 'second');
}

const utcLong = (ts: number) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export const utcAt = utcLong;

/** The schedule in one sentence. */
export function scheduleText(s: SeriesRead): string {
  if (isCalendar(s)) return `One cross at the start of each session of the calendar ${shortAddress(s.schedule.calendar)}`;
  const sched = s.schedule as { startTs: Big; intervalSecs: Big };
  const start = asNumber(sched.startTs);
  const every = asNumber(sched.intervalSecs);
  if (start === null || every === null) return 'The schedule could not be read';
  return `One cross every ${everyText(every)}, from ${utcLong(start)}`;
}

export const countText = (s: SeriesRead): string => {
  const max = big(s.maxCrosses);
  const next = (big(s.next) ?? 0n).toString();
  return max !== null && max > 0n ? `${next} of ${max.toString()} spawned` : `${next} spawned, no limit`;
};

// ---------------------------------------------------------------------------------------------------- the creation form

export type SeriesForm = {
  seriesId: string;
  baseMint: string;
  quoteMint: string;
  kind: 'recurring' | 'reopen';
  disclosure: 'open' | 'sealed';
  revealMins: string;
  schedule: 'interval' | 'calendar';
  startAt: string;
  intervalHours: string;
  calendar: string;
  callMins: string;
  gridMode: 'relative' | 'fixed';
  centerPrice: string;
  tickPct: string;
  ticks: string;
  minPrice: string;
  tick: string;
  minMatched: string;
  maxImbalancePct: string;
  integrator: string;
  integratorFeePct: string;
  gateMint: string;
  shards: string;
  maxOrders: string;
  proceedsTo: string;
  maxCrosses: string;
  rules: 'none' | 'ending';
};

export const EMPTY_SERIES_FORM: SeriesForm = {
  seriesId: '1',
  baseMint: '',
  quoteMint: '',
  kind: 'recurring',
  disclosure: 'open',
  revealMins: '',
  schedule: 'interval',
  startAt: '',
  intervalHours: '168',
  calendar: '',
  callMins: '120',
  gridMode: 'relative',
  centerPrice: '',
  tickPct: '1',
  ticks: '41',
  minPrice: '',
  tick: '',
  minMatched: '',
  maxImbalancePct: '',
  integrator: '',
  integratorFeePct: '0',
  gateMint: '',
  shards: '4',
  maxOrders: '10000',
  proceedsTo: '',
  maxCrosses: '',
  rules: 'none',
};

export type MintInfo = { decimals: number; program: string };
export type SeriesErrors = Partial<Record<keyof SeriesForm, string>>;
export type SeriesBuild = { body: Record<string, unknown> | null; errors: SeriesErrors };

const whole = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);
/** A percentage with at most two decimals, as basis points. */
const pctBps = (s: string): number | null => {
  const t = s.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/** Turns the form into the body of POST /v1/tx/create-series, naming every field it cannot read. The body is null while anything is wrong. */
export function buildSeries(f: SeriesForm, ctx: { authority: string | null; base: MintInfo | null; quote: MintInfo | null }): SeriesBuild {
  const errors: SeriesErrors = {};
  const bad = (k: keyof SeriesForm, m: string) => {
    errors[k] = m;
  };
  const addr = (k: keyof SeriesForm, what: string, required = true) => {
    const v = (f[k] as string).trim();
    if (v === '' && !required) return undefined;
    if (!isAddress(v)) {
      bad(k, v === '' ? `${what} is required.` : `${what} is not a Solana address.`);
      return undefined;
    }
    return v;
  };

  const id = /^\d{1,15}$/.test(f.seriesId.trim()) ? f.seriesId.trim() : null;
  if (id === null) bad('seriesId', 'The series number is a whole number, for example 1. Each number can be used once by a wallet.');
  const baseMint = addr('baseMint', 'The token');
  const quoteMint = addr('quoteMint', 'The quote token');
  if (baseMint && ctx.base === null) bad('baseMint', 'This is not a token this page could read on the network.');
  if (quoteMint && ctx.quote === null) bad('quoteMint', 'This is not a token this page could read on the network.');
  if (baseMint && quoteMint && baseMint === quoteMint) bad('quoteMint', 'The quote token must differ from the token being traded.');

  const market: Market | null = ctx.base && ctx.quote ? { priceScale: 10n ** BigInt(ctx.base.decimals), baseDecimals: ctx.base.decimals, quoteDecimals: ctx.quote.decimals } : null;

  // call, reveal
  const call = whole(f.callMins);
  if (call === null || call < 1) bad('callMins', 'The call lasts a whole number of minutes, at least 1.');
  let revealSecs = 0;
  if (f.disclosure === 'sealed') {
    const r = whole(f.revealMins);
    if (r === null || r < 1) bad('revealMins', 'A sealed call needs a reveal window: a whole number of minutes, at least 1.');
    else revealSecs = r * 60;
  } else if (f.revealMins.trim() !== '' && whole(f.revealMins) !== 0) bad('revealMins', 'An open call has no reveal window. Leave this empty, or choose sealed.');

  // schedule
  let startTs = 0;
  let intervalSecs = 0;
  let calendar: string | undefined;
  if (f.schedule === 'interval') {
    const hours = whole(f.intervalHours);
    if (hours === null || hours < 1) bad('intervalHours', 'The interval is a whole number of hours, at least 1.');
    else intervalSecs = hours * 3600;
    const at = f.startAt.trim() === '' ? NaN : new Date(f.startAt).getTime();
    if (Number.isNaN(at)) bad('startAt', 'Choose when the first slot falls.');
    else startTs = Math.floor(at / 1000);
    if (call !== null && intervalSecs > 0 && call * 60 + revealSecs >= intervalSecs) bad('callMins', 'The call and its reveal window must be shorter than the interval, or one cross would still be running when the next is due.');
  } else {
    calendar = addr('calendar', 'The calendar');
  }

  // grid
  const grid = { relative: f.gridMode === 'relative', minPrice: '0', tick: '0', ticks: 0, tickBps: 0, center: '0' };
  const ticks = whole(f.ticks);
  if (ticks === null || ticks < 2 || ticks > 65_535) bad('ticks', 'The grid has 2 to 65,535 price steps.');
  else grid.ticks = ticks;
  if (f.gridMode === 'relative') {
    const bps = pctBps(f.tickPct);
    if (bps === null || bps < 1 || bps > 10_000) bad('tickPct', 'A step is a percentage of the last price, from 0.01 to 100, with at most two decimals.');
    else grid.tickBps = bps;
    if (f.centerPrice.trim() === '') bad('centerPrice', 'The first cross is centred on this price; later ones centre on the last price that printed.');
    else if (!market) bad('centerPrice', 'Enter both tokens first so the price can be read exactly.');
    else {
      const p = parsePrice(f.centerPrice, market);
      if (p === null || p === 0n) bad('centerPrice', `Enter a price above zero with at most ${market.quoteDecimals} decimal places.`);
      else grid.center = p.toString();
    }
  } else {
    if (!market) {
      if (f.minPrice.trim() !== '' || f.tick.trim() !== '') bad('minPrice', 'Enter both tokens first so the price can be read exactly.');
      else bad('minPrice', 'The lowest price of the grid is required.');
    } else {
      const lo = parsePrice(f.minPrice, market);
      if (lo === null || lo === 0n) bad('minPrice', `Enter a price above zero with at most ${market.quoteDecimals} decimal places.`);
      else grid.minPrice = lo.toString();
      const st = parsePrice(f.tick, market);
      if (st === null || st === 0n) bad('tick', `Enter a step above zero with at most ${market.quoteDecimals} decimal places.`);
      else grid.tick = st.toString();
    }
  }

  // amounts
  let minMatched = '0';
  if (f.minMatched.trim() !== '') {
    if (ctx.base === null) bad('minMatched', 'Enter the token first so the amount can be read exactly.');
    else {
      const a = parseAtoms(f.minMatched, ctx.base.decimals);
      if (a === null) bad('minMatched', `The minimum volume is an amount of tokens with at most ${ctx.base.decimals} decimal places.`);
      else minMatched = a.toString();
    }
  }
  let maxImbalanceBps: number | undefined;
  if (f.maxImbalancePct.trim() !== '') {
    const b = pctBps(f.maxImbalancePct);
    if (b === null || b > 10_000) bad('maxImbalancePct', 'A percentage from 0 to 100 with at most two decimals, or leave it empty for no limit.');
    else maxImbalanceBps = b;
  }
  const feeBps = pctBps(f.integratorFeePct);
  if (feeBps === null || feeBps > 300) bad('integratorFeePct', 'The integrator fee is a percentage from 0 to 3 with at most two decimals.');
  const integrator = addr('integrator', 'The integrator address');
  const proceedsTo = addr('proceedsTo', 'The proceeds address');
  const gateMint = addr('gateMint', 'The gate mint', false);
  const shards = whole(f.shards);
  if (shards === null || shards < 1 || shards > 32) bad('shards', 'Use 1 to 32 shards.');
  const maxOrders = whole(f.maxOrders);
  if (maxOrders === null || maxOrders < 1 || maxOrders > 1_000_000) bad('maxOrders', 'Allow 1 to 1,000,000 orders in one cross.');
  let maxCrosses = '0';
  if (f.maxCrosses.trim() !== '') {
    const m = /^\d{1,9}$/.test(f.maxCrosses.trim()) ? Number(f.maxCrosses.trim()) : null;
    if (m === null || m < 1) bad('maxCrosses', 'A whole number of at least 1, or leave it empty for no limit.');
    else maxCrosses = String(m);
  }

  // rules
  let rules: RulesJson | undefined;
  if (f.rules === 'ending') {
    const preset = rulePreset('hard-to-game-ending');
    if (!preset) bad('rules', 'The ending preset is not available.');
    else {
      if (call !== null && call < 61) bad('callMins', 'A hard-to-game ending takes the last 30 minutes of the call and closes cancels 30 minutes before that: the call must be longer than an hour.');
      const built = buildRules({ ...EMPTY_RULES_FORM, ...applyRulePreset(preset) }, { baseDecimals: ctx.base?.decimals ?? null, quoteDecimals: ctx.quote?.decimals ?? null, market });
      if (built.json) rules = built.json;
    }
  }

  if (Object.keys(errors).length > 0 || id === null || !baseMint || !quoteMint || !ctx.base || !ctx.quote || !ctx.authority || call === null || ticks === null || feeBps === null || !integrator || !proceedsTo || shards === null || maxOrders === null) return { body: null, errors };

  const config: Record<string, unknown> = {
    kind: f.kind,
    disclosure: f.disclosure,
    priceScale: (10n ** BigInt(ctx.base.decimals)).toString(),
    grid,
    startTs,
    intervalSecs,
    callSecs: call * 60,
    revealSecs,
    minMatched,
    integratorFeeBps: feeBps,
    integrator,
    shards,
    maxOrders,
    proceedsTo,
    maxCrosses,
    ...(calendar ? { calendar } : {}),
    ...(maxImbalanceBps !== undefined ? { maxImbalanceBps } : {}),
    ...(gateMint ? { gateMint } : {}),
    ...(rules ? { rules } : {}),
  };
  return {
    body: { authority: ctx.authority, seriesId: id, baseMint, quoteMint, baseTokenProgram: ctx.base.program, quoteTokenProgram: ctx.quote.program, config },
    errors,
  };
}

/** What the series will do, in the words a person reads before signing. Written from the built body, so it states what is committed. */
export function seriesSummary(body: Record<string, unknown>, m: { base: MintInfo; quote: MintInfo }): string[] {
  const c = body.config as Record<string, any>;
  const lines: string[] = [];
  const price = (atoms: string) => formatAtoms((BigInt(atoms) * 10n ** BigInt(m.base.decimals)) / BigInt(c.priceScale), m.quote.decimals);
  lines.push(c.calendar ? `A cross opens for each session of the calendar ${shortAddress(c.calendar)} and closes at the session start.` : `A cross closes every ${everyText(c.intervalSecs)}, from ${utcLong(c.startTs)}; a slot that is missed is skipped, never run late.`);
  lines.push(`Each call takes orders for ${c.callSecs / 60} minutes${c.disclosure === 'sealed' ? `, then ${c.revealSecs / 60} minutes to reveal sealed orders` : ', with the book open'}.`);
  lines.push(
    c.grid.relative
      ? `The price grid has ${c.grid.ticks} steps of ${(c.grid.tickBps / 100).toString()}% of the last price, centred on ${price(c.grid.center)} for the first cross and on the last printed price after that.`
      : `The price grid has ${c.grid.ticks} steps of ${price(c.grid.tick)} from ${price(c.grid.minPrice)}, the same for every cross.`,
  );
  lines.push(c.maxCrosses === '0' ? 'It runs until its authority pauses it.' : `It stops after ${c.maxCrosses} crosses.`);
  lines.push('Anyone can spawn the next cross when it is due. Only the authority can pause the series and withdraw what it holds; nothing else about it can change.');
  if (c.rules) lines.push('Every cross carries the hard-to-game ending: the last 30 minutes in 6 buckets, a drawn last counted bucket, cancels closed 30 minutes before.');
  return lines;
}
