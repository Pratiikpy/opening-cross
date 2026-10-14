// What a phone shows about a cross that belongs to a recurring series, or that honours a halt. The pure core of the web app's series and halt
// notes (apps/web/src/components/cross/series-halt-note.tsx, apps/web/src/lib/halts.ts); the phone app is a separate project and cannot import
// them, so the two are kept equal by the same cases in test/schedule.test.ts. Nothing here reads the network.
import { duration } from './rules';
import { shortAddress } from './units';

type Big = string | number;
export type SeriesRead = { series: string; active: boolean; next: Big; maxCrosses: Big | null; schedule: { calendar: string } | { startTs: Big; intervalSecs: Big }; crosses: { idx: Big; cross_address: string; close_ts: Big }[] };
export type HaltState = { halted: boolean; reason: string; corporateAction: boolean; since: Big | null };
export type HaltRead = { baseMint: string; state?: HaltState };

const REASON: Record<string, string> = { 'issuer-pause': 'paused by the issuer', 'venue-halt': 'halted by the venue', 'circuit-breaker': 'stopped by the circuit breaker', 'corporate-action': 'a corporate action is in progress' };

export function scheduleText(s: SeriesRead): string {
  if ('calendar' in s.schedule) return 'One cross at the start of each session of a market calendar';
  const every = Number(s.schedule.intervalSecs);
  return Number.isFinite(every) && every > 0 ? `One cross every ${duration(String(every))}` : 'The schedule could not be read';
}

export function countText(s: SeriesRead): string {
  const max = s.maxCrosses === null ? 0n : BigInt(s.maxCrosses);
  return max > 0n ? `${s.next} of ${max} spawned` : `${s.next} spawned, no limit`;
}

/** The sentence under a cross that a series spawned. */
export function seriesNote(s: SeriesRead, cross: string): string {
  const mine = s.crosses.find((c) => c.cross_address === cross);
  return `${mine ? `Cross ${mine.idx} of the recurring series` : 'A cross of the recurring series'} ${shortAddress(s.series)}. ${scheduleText(s)}; ${countText(s)}. ${s.active ? 'The series is running.' : 'The series is paused, so it spawns no further cross.'}`;
}

/** The banner of a cross that honours a halt, or null when nothing is stopped. */
export function haltBanner(h: HaltRead | null, state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized'): string | null {
  const s = h?.state;
  if (!s || (!s.halted && !s.corporateAction)) return null;
  const head = s.halted ? `Trading in this token is halted: ${REASON[s.reason] ?? s.reason}.` : 'A corporate action is flagged on this token.';
  const tail = state === 'Live' ? 'This cross honours the halt: while it lasts it will not print, and every order is refunded in full.' : state === 'NoPrint' ? 'This cross did not print.' : 'This cross printed before the halt.';
  return `${head} ${tail} Only a printing resume cross lifts a halt.`;
}
