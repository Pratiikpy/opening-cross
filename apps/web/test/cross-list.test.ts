import { describe, expect, it } from 'vitest';
import type { CrossSummary } from '../src/lib/api';
import { buildCalendar, dayKey, formatWindow, sectionOf } from '../src/lib/calendar';
import { type CrossTraits, NO_FILTERS, applyFilters, livePhase, needsDetail, outcomeOf, parseFilters, serializeFilters } from '../src/lib/cross-list';

const NOW = 1_791_856_000;
let n = 0;
function cross(p: Partial<CrossSummary> & { open?: number; close?: number }): CrossSummary {
  const { open = NOW - 1000, close = NOW - 500, ...rest } = p;
  n += 1;
  return {
    address: `Cross${String(n).padStart(3, '0')}${'1'.repeat(30)}`,
    state: 'Finalized',
    creator: 'Creator1111111111111111111111111111111111',
    base_mint: `Base${n}${'2'.repeat(30)}`,
    quote_mint: `Quote${n}${'3'.repeat(30)}`,
    open_ts: String(open),
    close_ts: String(close),
    reveal_end_ts: String(close),
    clearing_price: '1300000',
    matched: '1',
    orders_committed: 0,
    ...rest,
  };
}

describe('outcomeOf', () => {
  it('maps state to the four outcomes, and a finalised cross without a price is a no-print', () => {
    expect(outcomeOf({ state: 'Live', clearing_price: null })).toBe('live');
    expect(outcomeOf({ state: 'Cleared', clearing_price: '5' })).toBe('cleared');
    expect(outcomeOf({ state: 'NoPrint', clearing_price: null })).toBe('noprint');
    expect(outcomeOf({ state: 'Finalized', clearing_price: null })).toBe('noprint');
    expect(outcomeOf({ state: 'Finalized', clearing_price: '5' })).toBe('finalized');
  });
});

describe('livePhase', () => {
  const c = cross({ state: 'Live', open: NOW + 60, close: NOW + 360 });
  it('follows the clock', () => {
    expect(livePhase(c, BigInt(NOW))).toBe('upcoming');
    expect(livePhase(c, BigInt(NOW + 60))).toBe('open');
    expect(livePhase(c, BigInt(NOW + 360))).toBe('awaiting-settlement');
    expect(livePhase({ ...c, reveal_end_ts: String(NOW + 400) }, BigInt(NOW + 380))).toBe('reveal');
  });
});

describe('filters in the URL', () => {
  it('round-trips and leaves defaults out', () => {
    expect(serializeFilters(NO_FILTERS)).toBe('');
    const f = { state: 'cleared', disclosure: 'sealed', supply: 'mint', q: 'abc', sort: 'orders-desc' } as const;
    const qs = serializeFilters(f);
    expect(parseFilters(new URLSearchParams(qs))).toEqual(f);
  });
  it('drops unknown values instead of trusting them', () => {
    const f = parseFilters({ state: 'bogus', disclosure: ['sealed', 'open'], supply: 'x', sort: '__proto__', q: 'a'.repeat(200) });
    expect(f.state).toBeNull();
    expect(f.disclosure).toBe('sealed');
    expect(f.supply).toBeNull();
    expect(f.sort).toBe('newest');
    expect(f.q).toHaveLength(64);
  });
  it('only asks for per-cross detail when a filter needs it', () => {
    expect(needsDetail(NO_FILTERS)).toBe(false);
    expect(needsDetail({ ...NO_FILTERS, state: 'live' })).toBe(false);
    expect(needsDetail({ ...NO_FILTERS, disclosure: 'open' })).toBe(true);
    expect(needsDetail({ ...NO_FILTERS, supply: 'escrow' })).toBe(true);
  });
});

describe('applyFilters', () => {
  const a = cross({ state: 'Live', open: NOW - 10, close: NOW + 300, orders_committed: 3 });
  const b = cross({ state: 'Cleared', orders_committed: 9 });
  const c = cross({ state: 'Finalized', orders_committed: 1 });
  const d = cross({ state: 'Finalized', clearing_price: null, orders_committed: 0 });
  const all = [a, b, c, d];
  const traits = new Map<string, CrossTraits>([
    [a.address, { disclosure: 'sealed', supplyMode: 'mint' }],
    [b.address, { disclosure: 'open', supplyMode: 'escrow' }],
    [c.address, { disclosure: 'open', supplyMode: 'mint' }],
  ]);
  const ids = (f: Partial<typeof NO_FILTERS>) => applyFilters(all, { ...NO_FILTERS, ...f }, traits).map((x) => x.address);

  it('keeps the API order with no filters', () => expect(ids({})).toEqual([a, b, c, d].map((x) => x.address)));
  it('filters by state', () => {
    expect(ids({ state: 'live' })).toEqual([a.address]);
    expect(ids({ state: 'noprint' })).toEqual([d.address]);
    expect(ids({ state: 'finalized' })).toEqual([c.address]);
  });
  it('filters by disclosure and supply, and leaves out crosses whose detail is not known', () => {
    expect(ids({ disclosure: 'open' })).toEqual([b.address, c.address]);
    expect(ids({ supply: 'mint' })).toEqual([a.address, c.address]);
    expect(ids({ disclosure: 'open', supply: 'mint' })).toEqual([c.address]);
  });
  it('searches addresses and mints, ignoring case', () => {
    expect(ids({ q: a.address.toLowerCase().slice(0, 10) })).toEqual([a.address]);
    expect(ids({ q: b.base_mint })).toEqual([b.address]);
    expect(ids({ q: c.quote_mint.toUpperCase() })).toEqual([c.address]);
    expect(ids({ q: 'nothing-like-this' })).toEqual([]);
  });
  it('sorts by close time and by order count, keeping the API order on ties', () => {
    expect(ids({ sort: 'orders-desc' })).toEqual([b, a, c, d].map((x) => x.address));
    expect(ids({ sort: 'close-desc' })[0]).toBe(a.address);
    expect(ids({ sort: 'close-asc' }).at(-1)).toBe(a.address);
    expect(ids({ sort: 'close-asc' }).slice(0, 3)).toEqual([b, c, d].map((x) => x.address));
  });
});

describe('calendar', () => {
  const live = cross({ state: 'Live', open: NOW - 30, close: NOW + 270 });
  const soon = cross({ state: 'Live', open: NOW + 3600, close: NOW + 3900 });
  const later = cross({ state: 'Live', open: NOW + 86_400 * 2, close: NOW + 86_400 * 2 + 300 });
  const stuck = cross({ state: 'Live', open: NOW - 5000, close: NOW - 4000 });
  const done = cross({ state: 'Finalized', open: NOW - 90_000, close: NOW - 89_700 });
  const all = [done, later, stuck, live, soon];

  it('puts each cross in the section its clock says', () => {
    const n = BigInt(NOW);
    expect(sectionOf(live, n)).toBe('open');
    expect(sectionOf(soon, n)).toBe('soon');
    expect(sectionOf(stuck, n)).toBe('closed');
    expect(sectionOf(done, n)).toBe('closed');
  });

  it('groups by day in the given zone, soonest first for upcoming and newest first for closed', () => {
    const s = buildCalendar(all, NOW, 'UTC');
    expect(s.map((x) => [x.id, x.count])).toEqual([['open', 1], ['soon', 2], ['closed', 2]]);
    expect(s[1]!.groups.flatMap((g) => g.items.map((i) => i.address))).toEqual([soon.address, later.address]);
    expect(s[2]!.groups.flatMap((g) => g.items.map((i) => i.address))).toEqual([stuck.address, done.address]);
    for (const g of s.flatMap((x) => x.groups)) expect(new Set(g.items.map(() => g.key)).size).toBe(1);
  });

  it('uses the viewer zone for day boundaries', () => {
    // 20:00 UTC on the 12th is 01:30 on the 13th in India.
    const t = Date.UTC(2026, 9, 12, 20, 0, 0) / 1000;
    expect(dayKey(t, 'UTC')).toBe('2026-10-12');
    expect(dayKey(t, 'Asia/Kolkata')).toBe('2026-10-13');
    expect(dayKey(t, 'America/Los_Angeles')).toBe('2026-10-12');
  });

  it('formats a window in a zone, with dates only when it crosses midnight there', () => {
    const t = Date.UTC(2026, 9, 12, 20, 0, 0) / 1000;
    expect(formatWindow(t, t + 300, 'UTC')).toBe('20:00 to 20:05 UTC');
    expect(formatWindow(t, t + 300, 'Asia/Kolkata')).toMatch(/^01:30 to 01:35 (IST|GMT\+5:30)$/);
    expect(formatWindow(t, t + 5 * 3600, 'UTC')).toBe('12 Oct, 20:00 to 13 Oct, 01:00 UTC');
  });

  it('has an empty section when nothing falls in it', () => {
    const s = buildCalendar([done], NOW, 'UTC');
    expect(s[0]!.groups).toEqual([]);
    expect(s[0]!.empty).toMatch(/No cross/);
  });
});
