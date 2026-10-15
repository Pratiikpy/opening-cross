import { describe, expect, it } from 'vitest';
import { type BackingRead, type ListingRow, backingBanner, governedNote, listingNote } from '../src/lib/wave3d';

const listing = (status: ListingRow['status']): ListingRow => ({ listing: 'L', venue: '39WubcQMBt3rHiwABcMov6kXVF8C3JDUx6TLugP3toD2', lister: '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr', cross: 'X', amount: '1', status });

describe('listing note', () => {
  it('says what each state of the bond means', () => {
    expect(listingNote(listing('open'))).toMatch(/^Listed with a bond at stake on venue 39Wu…toD2 by 2E2a…KQrr\. .*only if the cross fails because its settlement never happened/);
    expect(listingNote(listing('released'))).toMatch(/the bond was released.*without the fault/);
    expect(listingNote(listing('slashed'))).toMatch(/the bond was slashed.*settlement never happened/);
  });
});

describe('backing banner', () => {
  const b = (o: Partial<BackingRead> = {}): BackingRead => ({ optedIn: true, policy: { minCoverageBps: 10_000, maxAgeSecs: '3600' }, verdict: 'Stale', halt: { halted: false }, ...o });
  it('is silent without a policy, with no verdict, or when the token is backed', () => {
    expect(backingBanner(null)).toBeNull();
    expect(backingBanner(b({ optedIn: false, policy: null }))).toBeNull();
    expect(backingBanner(b({ verdict: null }))).toBeNull();
    expect(backingBanner(b({ verdict: 'Backed' }))).toBeNull();
  });
  it('says what failed, and that the next check halts the token or that the halt is not lifted by a statement', () => {
    expect(backingBanner(b())).toMatch(/stale.*next check, which anyone can run, halts the token/);
    expect(backingBanner(b({ verdict: 'Short' }))).toMatch(/short/);
    expect(backingBanner(b({ verdict: 'Missing' }))).toMatch(/no statement has been posted/);
    expect(backingBanner(b({ halt: { halted: true } }))).toMatch(/halted.*only a printing resume cross does/);
  });
});

describe('governed note', () => {
  const g = { governed: true, release: { deployed: true as boolean | null } };
  it('is silent for an ungoverned cross, a missing read, and a network without the program', () => {
    expect(governedNote(null)).toBeNull();
    expect(governedNote({ ...g, governed: false })).toBeNull();
    expect(governedNote({ ...g, release: { deployed: false } })).toBeNull();
  });
  it('names the venue the holders chose, or the vote in progress, or that no vote has passed', () => {
    expect(governedNote({ ...g, outcome: { venue: 'dlmm' } })).toMatch(/only on the venue its holders voted for: Meteora DLMM\. Votes are cast on the web/);
    expect(governedNote({ ...g, rounds: [{ index: 0, status: 'voting', winner: null }] })).toMatch(/voting is open/);
    expect(governedNote({ ...g, rounds: [{ index: 0, status: 'awaiting-finalize', winner: null }] })).toMatch(/waiting to be finalized/);
    expect(governedNote(g)).toMatch(/no vote has passed yet/);
  });
});
