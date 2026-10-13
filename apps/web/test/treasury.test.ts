import { describe, expect, it } from 'vitest';
import { DISCLOSURE_LABEL, KIND_LABEL, duration, eventSummary, explorerAddress, quote, utc } from '../src/lib/treasury';

describe('treasury formatting', () => {
  it('formats durations in the two largest units', () => {
    expect(duration('2592000')).toBe('30 days');
    expect(duration('604800')).toBe('7 days');
    expect(duration('90')).toBe('1 minute 30 seconds');
    expect(duration('86401')).toBe('1 day 1 second');
    expect(duration('0')).toBe('0 seconds');
    expect(duration('junk')).toBe('0 seconds');
  });

  it('formats quote amounts exactly from decimal strings and says so when a figure is unavailable', () => {
    expect(quote('10000000001', 6)).toBe('10,000.000001 quote');
    expect(quote('1000000000', 6)).toBe('1,000 quote');
    expect(quote('18446744073709551615', 6)).toBe('18,446,744,073,709.551615 quote');
    expect(quote(null, 6)).toBe('unavailable');
  });

  it('formats unix seconds as UTC', () => {
    expect(utc(0)).toBe('1970-01-01 00:00 UTC');
    expect(utc('1791883372')).toBe('2026-10-13 09:22 UTC');
  });

  it('describes every program event from its own fields', () => {
    const e = (name: string, details: Record<string, string>) => ({ signature: 's', slot: '1', time: 1, name, details });
    expect(eventSummary(e('TreasuryCreated', { allowance: '1000000000', periodSecs: '2592000' }), 6)).toBe('Created with an allowance of 1,000 quote per 30 days.');
    expect(eventSummary(e('Spent', { amount: '250000000', spentInPeriod: '250000000' }), 6)).toContain('Team spent 250 quote');
    expect(eventSummary(e('AttestationLapsed', { at: '0' }), 6)).toContain('1970-01-01');
    expect(eventSummary(e('LiquidationStarted', { vault: '8000000001', supply: '1000000000' }), 6)).toContain('8,000.000001 quote over 1000000000 coin atoms');
    expect(eventSummary(e('Redeemed', { burned: '600000000', paid: '4800000000' }), 6)).toContain('4,800 quote');
    expect(eventSummary(e('SomethingNew', {}), 6)).toBe('SomethingNew');
  });

  it('labels every disclosure state and card kind, and links addresses on the right cluster for the configured RPC', () => {
    expect(Object.keys(DISCLOSURE_LABEL).sort()).toEqual(['closed', 'current', 'overdue', 'requested', 'unknown']);
    expect(Object.keys(KIND_LABEL).sort()).toEqual(['caveat', 'entitles', 'not-provided', 'protects']);
    expect(explorerAddress('A')).toMatch(/^https:\/\/explorer\.solana\.com\/address\/A(\?cluster=devnet)?$/);
  });
});
