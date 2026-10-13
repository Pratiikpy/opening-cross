// What the crosses list says about a cross, by its clock. A cross the indexer still calls Live is open only between its open and close
// times: after the close it is waiting for someone to settle it, and the list must not call that open.
import type { CrossSummary } from './api';

export type Badge = { label: string; tone: 'live' | 'good' | 'plain' };

export function badgeOf(c: Pick<CrossSummary, 'state' | 'open_ts' | 'close_ts'>, nowSec: number): Badge {
  if (c.state === 'Cleared') return { label: 'Cleared', tone: 'good' };
  if (c.state === 'Finalized') return { label: 'Finalized', tone: 'plain' };
  if (c.state === 'NoPrint') return { label: 'No print', tone: 'plain' };
  if (nowSec < Number(c.open_ts)) return { label: 'Opens soon', tone: 'plain' };
  if (nowSec < Number(c.close_ts)) return { label: 'Open', tone: 'live' };
  return { label: 'Awaiting settlement', tone: 'plain' };
}
