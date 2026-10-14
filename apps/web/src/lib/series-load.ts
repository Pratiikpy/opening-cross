'use client';

// Reads for the series and halt screens, all from the Opening Cross API and the cluster the app is pointed at. A read that fails returns the
// reason; a screen never shows a figure it did not read.
import { apiRead, type Result } from './issuer-data';
import { ata } from './issuer-chain';
import { RPC_URL } from './config';
import { rpcBatch } from './power';
import type { CrossStateName, SeriesListRow, SeriesRead } from './series';
import type { FeedRead, HaltRead } from './halts';
import type { CrossDetail } from './types';

export const loadSeriesList = (authority?: string | null) => apiRead<{ series: SeriesListRow[] }>(`/v1/series${authority ? `?authority=${authority}` : ''}`);
export const loadSeries = (address: string) => apiRead<SeriesRead>(`/v1/series/${address}`);

/** The list holds at most this many series (GET /v1/series); a longer list may not contain the one asked for, so it is asked directly. */
const LIST_LIMIT = 100;
/**
 * One series, after checking the list: an address that is not a series would otherwise provoke a 404 that the browser logs as an error on a page
 * that handles it correctly. A list that is as long as the API serves is not conclusive, so then the series is asked for directly.
 */
export async function loadSeriesChecked(address: string): Promise<Result<SeriesRead>> {
  const list = await loadSeriesList();
  if (list.ok && list.data.series.length < LIST_LIMIT && !list.data.series.some((s) => s.address === address)) return { ok: false, error: `No recurring series exists at ${address} on this network.` };
  return loadSeries(address);
}
export const loadHalt = (baseMint: string) => apiRead<HaltRead>(`/v1/halts/${baseMint}`);
export const loadFeed = (baseMint: string) => apiRead<FeedRead>(`/v1/feeds/${baseMint}`);

/**
 * The upcoming session starts of a calendar, soonest first. Read from the list of calendars (GET /v1/calendar), not from the calendar's own route:
 * a calendar the list does not hold would be a 404 that the browser logs as an error on a page that handles it correctly. A list as long as the API
 * serves is not conclusive, so then the calendar is asked for directly.
 */
const CALENDAR_LIST_LIMIT = 200;
type CalendarRead = { address: string; schedule: { startTs: string }[] };
export async function loadSessionStarts(calendar: string): Promise<Result<number[]>> {
  const list = await apiRead<{ calendars: CalendarRead[] }>(`/v1/calendar?limit=${CALENDAR_LIST_LIMIT}`);
  if (list.ok) {
    const hit = list.data.calendars.find((c) => c.address === calendar);
    if (hit) return { ok: true, data: hit.schedule.map((s) => Number(s.startTs)) };
    if (list.data.calendars.length < CALENDAR_LIST_LIMIT) return { ok: false, error: `The calendar ${calendar} is not known to the API.` };
  }
  const r = await apiRead<CalendarRead>(`/v1/calendar/${calendar}`);
  return r.ok ? { ok: true, data: r.data.schedule.map((s) => Number(s.startTs)) } : r;
}

export type CrossBrief = { address: string; state: CrossStateName; closeTs: string; clearingPrice: string | null; matched: string | null; noPrintReason: string | null; ordersTotal: number };
export async function loadCrossBrief(address: string): Promise<Result<CrossBrief>> {
  const r = await apiRead<CrossDetail>(`/v1/crosses/${address}`);
  if (!r.ok) return r;
  const c = r.data;
  return { ok: true, data: { address, state: c.state, closeTs: c.window.closeTs, clearingPrice: c.clearing?.price ?? null, matched: c.clearing?.matched ?? null, noPrintReason: c.noPrintReason, ordersTotal: c.orders.total } };
}

/** What a token account holds, from the cluster; null when the account does not exist or could not be read. */
export async function readHeld(owner: string, mint: string, program: string): Promise<{ ok: true; amount: bigint } | { ok: false; reason: string }> {
  try {
    const account = await ata(owner, mint, program);
    const [r] = (await rpcBatch(RPC_URL, [{ method: 'getAccountInfo', params: [account, { encoding: 'jsonParsed', commitment: 'confirmed' }] }])) as [{ value: { data: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } | null } | undefined];
    if (!r || !r.value) return { ok: true, amount: 0n };
    const amount = r.value.data.parsed?.info?.tokenAmount?.amount;
    return amount === undefined ? { ok: false, reason: 'The token account could not be decoded.' } : { ok: true, amount: BigInt(amount) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'The network could not be reached.' };
  }
}
