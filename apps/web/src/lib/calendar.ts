// Lays crosses out on a calendar by their real windows. Sections follow the clock; days follow a time zone, so the
// same data is grouped by the viewer's local day in the browser and by UTC day on the server.
import type { CrossSummary } from './api';
import { livePhase } from './cross-list';

export type SectionId = 'open' | 'soon' | 'closed';

export type CalendarGroup = { key: string; label: string; items: CrossSummary[] };
export type CalendarSection = { id: SectionId; title: string; empty: string; groups: CalendarGroup[]; count: number };

export const SECTION_TITLE: Record<SectionId, string> = { open: 'Open now', soon: 'Opening soon', closed: 'Closed' };
const EMPTY: Record<SectionId, string> = {
  open: 'No cross is taking orders right now.',
  soon: 'No cross is scheduled to open.',
  closed: 'No cross has closed yet.',
};

export function sectionOf(c: CrossSummary, nowSec: bigint): SectionId {
  const phase = livePhase(c, nowSec);
  if (c.state !== 'Live') return 'closed';
  if (phase === 'upcoming') return 'soon';
  if (phase === 'open') return 'open';
  return 'closed';
}

/** `2026-10-13`: the calendar day of a unix time in `timeZone`. */
export function dayKey(unixSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

export function dayLabel(unixSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(unixSeconds * 1000));
}

/** The time that places a cross in a section: when it opens for the upcoming, when it closes for the rest. */
const anchorOf = (c: CrossSummary, s: SectionId): number => Number(s === 'soon' ? c.open_ts : c.close_ts);

export function buildCalendar(crosses: readonly CrossSummary[], nowSec: number, timeZone: string): CalendarSection[] {
  const now = BigInt(nowSec);
  const bySection: Record<SectionId, CrossSummary[]> = { open: [], soon: [], closed: [] };
  for (const c of crosses) bySection[sectionOf(c, now)].push(c);
  return (['open', 'soon', 'closed'] as const).map((id) => {
    // Soonest first for what is ahead, most recent first for what is done.
    const sign = id === 'closed' ? -1 : 1;
    const items = [...bySection[id]].sort((a, b) => sign * (anchorOf(a, id) - anchorOf(b, id)) || (a.address < b.address ? -1 : 1));
    const groups: CalendarGroup[] = [];
    for (const c of items) {
      const t = anchorOf(c, id);
      const key = dayKey(t, timeZone);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(c);
      else groups.push({ key, label: dayLabel(t, timeZone), items: [c] });
    }
    return { id, title: SECTION_TITLE[id], empty: EMPTY[id], groups, count: items.length };
  });
}

/** `10:00 to 10:05 IST`, or with dates when the window crosses midnight in that zone. */
export function formatWindow(openTs: number, closeTs: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const withDate = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(closeTs * 1000)).find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  const o = new Date(openTs * 1000);
  const c = new Date(closeTs * 1000);
  const same = dayKey(openTs, timeZone) === dayKey(closeTs, timeZone);
  return same ? `${time.format(o)} to ${time.format(c)} ${zone}` : `${withDate.format(o)} to ${withDate.format(c)} ${zone}`;
}
