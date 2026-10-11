// Market session of the underlying, from the issuer's own trading clock (`trading.currentPeriod` on the xStocks
// asset): market, extended, overnight or closed. "extended" covers both pre- and post-market; the hour in New York
// tells them apart.
import type { Session } from './types.js';

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });

export function sessionOf(period: string, atSeconds: number): Session | null {
  switch (period) {
    case 'market':
      return 'regular';
    case 'overnight':
      return 'overnight';
    case 'closed':
      return 'closed';
    case 'extended': {
      const hour = Number(NY.format(new Date(atSeconds * 1000)));
      return hour < 12 ? 'pre' : 'post';
    }
    default:
      return null;
  }
}
