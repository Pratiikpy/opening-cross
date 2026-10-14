import { describe, expect, it } from 'vitest';
import { countText, haltBanner, scheduleText, seriesNote, type SeriesRead } from '../src/lib/schedule';

const series = (o: Partial<SeriesRead> = {}): SeriesRead => ({ series: '39WubcQMBt3rHiwABcMov6kXVF8C3JDUx6TLugP3toD2', active: true, next: '3', maxCrosses: null, schedule: { startTs: '1', intervalSecs: '604800' }, crosses: [{ idx: '2', cross_address: 'X', close_ts: '5' }], ...o });

describe('series note', () => {
  it('says which cross it is, the schedule and the count', () => {
    expect(seriesNote(series(), 'X')).toBe('Cross 2 of the recurring series 39Wu…toD2. One cross every 7 days; 3 spawned, no limit. The series is running.');
  });
  it('says so when the series is paused, and names a cross the index has not seen without a number', () => {
    expect(seriesNote(series({ active: false }), 'Y')).toMatch(/^A cross of the recurring series .*paused, so it spawns no further cross/);
  });
  it('words the schedule and the limit', () => {
    expect(scheduleText(series({ schedule: { calendar: 'C' } }))).toMatch(/each session of a market calendar/);
    expect(scheduleText(series({ schedule: { startTs: '1', intervalSecs: '0' } }))).toBe('The schedule could not be read');
    expect(countText(series({ next: '2', maxCrosses: '5' }))).toBe('2 of 5 spawned');
  });
});

describe('halt banner', () => {
  const halted = { baseMint: 'M', state: { halted: true, reason: 'venue-halt', corporateAction: false, since: '1' } };
  it('is silent when nothing is stopped or nothing is known', () => {
    expect(haltBanner(null, 'Live')).toBeNull();
    expect(haltBanner({ baseMint: 'M' }, 'Live')).toBeNull();
    expect(haltBanner({ baseMint: 'M', state: { halted: false, reason: 'none', corporateAction: false, since: null } }, 'Live')).toBeNull();
  });
  it('says what the halt does to a live cross, a cross that did not print, and one that printed', () => {
    expect(haltBanner(halted, 'Live')).toMatch(/halted by the venue.*will not print, and every order is refunded in full.*Only a printing resume cross lifts a halt/);
    expect(haltBanner(halted, 'NoPrint')).toMatch(/This cross did not print/);
    expect(haltBanner(halted, 'Finalized')).toMatch(/printed before the halt/);
  });
  it('a corporate action is not called a halt', () => {
    expect(haltBanner({ baseMint: 'M', state: { halted: false, reason: 'none', corporateAction: true, since: null } }, 'Live')).toMatch(/^A corporate action is flagged/);
  });
});

import { PEG_NOTE, pegPrice } from '../src/lib/peg';

describe('pegged to the open', () => {
  const grid = { minPrice: '1000000', tick: '100000', ticks: 20 };
  it('a buy takes the top of the grid and a sell the bottom', () => {
    expect(pegPrice(grid, 'buy')).toBe(2_900_000n);
    expect(pegPrice(grid, 'sell')).toBe(1_000_000n);
    expect(PEG_NOTE.buy).toMatch(/top of the grid/);
    expect(PEG_NOTE.sell).toMatch(/bottom of the grid/);
  });
});
