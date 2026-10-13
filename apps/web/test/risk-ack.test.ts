import { describe, expect, it } from 'vitest';
import { RISK_POINTS, acknowledge, hasAcknowledged } from '../src/lib/risk-ack';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('risk acknowledgement', () => {
  it('is asked once per wallet on a device', () => {
    const s = memory();
    expect(hasAcknowledged('walletA', s)).toBe(false);
    expect(acknowledge('walletA', new Date('2026-10-13T00:00:00Z'), s)).toBe(true);
    expect(hasAcknowledged('walletA', s)).toBe(true);
    expect(hasAcknowledged('walletB', s)).toBe(false);
  });
  it('asks again where the browser would not store it, instead of skipping the step', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(acknowledge('walletA', new Date(), broken)).toBe(false);
    expect(hasAcknowledged('walletA', broken)).toBe(false);
    expect(hasAcknowledged('walletA', null)).toBe(false);
  });
  it('says the four things that matter, in plain words', () => {
    const t = RISK_POINTS.join(' ');
    expect(t).toMatch(/devnet/i);
    expect(t).toMatch(/lose everything/i);
    expect(t).toMatch(/revealed/i);
    expect(t).toMatch(/securities/i);
  });
});
