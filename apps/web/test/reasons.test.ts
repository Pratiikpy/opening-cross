import { describe, expect, it } from 'vitest';
import { explainCalibration } from '../src/lib/reasons';

describe('explainCalibration', () => {
  it('turns the machine codes into a sentence', () => {
    expect(explainCalibration('NEED_9_SAMPLES_FOR_A_BOUNDED_BAND (have 0); SAMPLES 0<30; DISTINCT_DAYS 0<2; HELD_OUT 0<20')).toBe(
      'A band claims a coverage only once enough crosses have been graded: at least 9 graded crosses to bound a band at all (0 so far); 0 of the 30 graded crosses needed; 0 of the 2 separate days needed; 0 of the 20 held-out checks needed.',
    );
  });

  it('explains an under-covering band in plain words', () => {
    expect(explainCalibration('COVERAGE_BELOW_NOMINAL measured 71.4% [52.1, 84.6] is below nominal 90%')).toBe(
      'On held-out crosses the band held 71.4% of the time (95% range 52.1% to 84.6%), below the 90% it would have to claim.',
    );
  });

  it('keeps anything it does not recognise, and says nothing for no reason', () => {
    expect(explainCalibration('SOMETHING_NEW 3')).toBe('SOMETHING_NEW 3');
    expect(explainCalibration('SAMPLES 3<30; SOMETHING_NEW 3')).toContain('SOMETHING_NEW 3');
    expect(explainCalibration(null)).toBeNull();
    expect(explainCalibration('')).toBeNull();
  });
});
