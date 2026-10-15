import { describe, expect, it } from 'vitest';
import { type NewProgramsRead, availabilityOf, networkName, offReason } from '../src/lib/new-programs';

const feature = (available: boolean | null) => ({ available, needs: ['cross_x'], note: 'a note' });
const read = (available: boolean | null): NewProgramsRead => ({ network: 'devnet', checkedAt: 1, programs: {}, features: { mandates: feature(available) } });

describe('availabilityOf', () => {
  it('is loading before the API has answered, and unavailable when it could not be asked', () => {
    expect(availabilityOf(undefined, 'mandates')).toEqual({ phase: 'loading' });
    expect(availabilityOf(null, 'mandates')).toEqual({ phase: 'unavailable' });
  });
  it('reports a feature as available, missing or not known, never turning one into another', () => {
    expect(availabilityOf(read(true), 'mandates')).toMatchObject({ phase: 'ready', available: true, network: 'devnet' });
    expect(availabilityOf(read(false), 'mandates')).toMatchObject({ available: false });
    expect(availabilityOf(read(null), 'mandates')).toMatchObject({ available: null });
  });
  it('treats a feature the API does not report as not known, not as missing', () => {
    expect(availabilityOf(read(true), 'bounty')).toMatchObject({ phase: 'ready', available: null, feature: null });
  });
});

describe('offReason', () => {
  it('switches an action off only when the feature is definitely not on the network, and says it is built and proved', () => {
    const r = offReason(availabilityOf(read(false), 'mandates'), 'Auto-invest mandates')!;
    expect(r).toMatch(/Auto-invest mandates is built and proved on LiteSVM and a local validator/);
    expect(r).toMatch(/not on devnet yet/);
    expect(r).toMatch(/H27, H43/);
  });
  it('leaves an action on when the release is on, unknown or unreadable: the transaction is simulated first', () => {
    expect(offReason(availabilityOf(read(true), 'mandates'), 'x')).toBeNull();
    expect(offReason(availabilityOf(read(null), 'mandates'), 'x')).toBeNull();
    expect(offReason(availabilityOf(null, 'mandates'), 'x')).toBeNull();
    expect(offReason(availabilityOf(undefined, 'mandates'), 'x')).toBeNull();
  });
});

describe('networkName', () => {
  it('names the network, or says this network', () => {
    expect(networkName('devnet')).toBe('devnet');
    expect(networkName(null)).toBe('this network');
  });
});
