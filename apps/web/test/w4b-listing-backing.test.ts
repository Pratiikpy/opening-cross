import { describe, expect, it } from 'vitest';
import { type BackingRead, EMPTY_POLICY, ageText, badgeOf, bpsPct, buildAttest, buildPolicy } from '../src/lib/backing';
import { EMPTY_VENUE, NEXT_LABEL, atomsText, bondLine, buildVenue, days, statusLine } from '../src/lib/listing';
import { isAddress } from '@solana/kit';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const NOW = 1_800_000_000;

describe('listing: buildVenue', () => {
  it('builds the terms in atoms and seconds, with slashed bonds going to the creator by default', () => {
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: A, minBond: '25', delayDays: '3' }, B, 6).body).toEqual({ creator: B, bondMint: A, minBond: '25000000', releaseDelaySecs: 259_200, slashTo: B });
  });
  it('holds the program’s bounds: a positive bond and a delay of at least a day', () => {
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: A, minBond: '0', delayDays: '3' }, B, 6).errors.minBond).toBeDefined();
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: A, minBond: '1', delayDays: '0' }, B, 6).errors.delayDays).toMatch(/at least 1/);
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: 'x', minBond: '1' }, B, 6).errors.bondMint).toMatch(/not a Solana address/);
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: A, minBond: '1', slashTo: C }, B, 6).body?.slashTo).toBe(C);
    expect(buildVenue({ ...EMPTY_VENUE, bondMint: A, minBond: '1' }, B, null).body).toBeNull();
  });
});

describe('listing: words', () => {
  it('says what each state of a listing means, and that a slash goes to the venue', () => {
    expect(statusLine({ status: 'open', slashedTo: null, lister: A }, '100 USDC')).toMatch(/100 USDC of the lister's bond is set aside/);
    expect(statusLine({ status: 'released', slashedTo: null, lister: A }, '100')).toMatch(/released to the lister/);
    expect(statusLine({ status: 'slashed', slashedTo: B, lister: A }, '100')).toMatch(/slashed to 6TLf…hZHx: the cross failed because its settlement never happened/);
  });
  it('labels every next step the API can answer', () => {
    expect(Object.keys(NEXT_LABEL).sort()).toEqual(['release', 'settled', 'slash', 'wait']);
  });
  it('writes a delay in days, and a bond line in the lister’s terms', () => {
    expect(days(172_800)).toBe('2 days');
    expect(days('86400')).toBe('1 day');
    expect(bondLine({ total: '250000000', setAside: '100000000', free: '150000000', fitsAnother: true }, 6, 'USDC')).toBe('Your bond: 250 USDC in total, 100 USDC set aside by open listings, 150 USDC free: enough to list another cross.');
    expect(bondLine({ opened: false }, 6, 'USDC')).toMatch(/no bond on this venue yet/);
    expect(bondLine(undefined, 6, 'USDC')).toMatch(/Connect a wallet/);
  });
  it('converts an amount typed in tokens, and nothing else', () => {
    expect(atomsText('20', 6)).toBe('20000000');
    expect(atomsText('0', 6)).toBeNull();
    expect(atomsText('1', null)).toBeNull();
    expect(atomsText('abc', 6)).toBeNull();
  });
});

const backing = (o: Partial<BackingRead> = {}): BackingRead => ({
  mint: A,
  optedIn: true,
  policy: { address: B, attester: C, minCoverageBps: 10_000, maxAgeSecs: '3600' },
  attestation: { backingAtoms: '1200000000', postedTs: String(NOW - 600), ageSecs: '600', freshUntil: String(NOW + 3_000) },
  supply: '1000000000',
  required: '1000000000',
  coverageBps: '12000',
  verdict: 'Backed',
  haltsOnNextCheck: false,
  watchdog: B,
  halt: null,
  release: { program: C, deployed: true },
  ...o,
});

describe('backing: badgeOf', () => {
  it('says a backed token is backed, by how much, and until when', () => {
    const b = badgeOf(backing(), 6, NOW);
    expect(b).toMatchObject({ tone: 'ok', title: 'Backed' });
    expect(b.lines[0]).toMatch(/10 minutes old.*covers 120% of the live supply.*committed to 100%/);
    expect(b.lines[1]).toMatch(/fresh until/);
  });
  it('says a stale statement is stale, and that the next check halts the token', () => {
    const b = badgeOf(backing({ verdict: 'Stale', attestation: { backingAtoms: '1200000000', postedTs: String(NOW - 7_200), ageSecs: '7200', freshUntil: String(NOW - 3_600) } }), 6, NOW);
    expect(b.title).toBe('Statement stale');
    expect(b.lines.join(' ')).toMatch(/older than the 60 minutes.*not halted yet.*halts it/);
  });
  it('says a short statement is under-backed, with the figures', () => {
    const b = badgeOf(backing({ verdict: 'Short', coverageBps: '5000', attestation: { backingAtoms: '500000000', postedTs: String(NOW - 600), ageSecs: '600', freshUntil: String(NOW + 3_000) } }), 6, NOW);
    expect(b.title).toBe('Under-backed');
    expect(b.lines[0]).toMatch(/covers 50%.*below the 100%.*500 against 1,000 required/);
  });
  it('says a missing statement cannot be verified', () => {
    expect(badgeOf(backing({ verdict: 'Missing', attestation: null }), 6, NOW).lines[0]).toMatch(/No statement has been posted/);
  });
  it('says a fresh statement does not lift a halt', () => {
    expect(badgeOf(backing({ halt: { halted: true, reason: 'venue-halt' } }), 6, NOW).lines.join(' ')).toMatch(/does not lift a halt/);
    expect(badgeOf(backing({ verdict: 'Stale', halt: { halted: true, reason: 'venue-halt', sinceTs: String(NOW - 3_600) } }), 6, NOW).lines.join(' ')).toMatch(/halted since .* UTC\. A fresh statement does not lift it/);
  });
  it('says a token with no policy is not watched, and invents no verdict', () => {
    expect(badgeOf(backing({ optedIn: false, policy: null, attestation: null, verdict: null }), 6, NOW)).toMatchObject({ tone: 'info', title: 'No backing policy' });
  });
});

describe('backing: forms', () => {
  it('builds a policy in basis points and seconds', () => {
    expect(buildPolicy(EMPTY_POLICY, A, B, isAddress).errors.attester).toBeDefined();
    expect(buildPolicy({ ...EMPTY_POLICY, attester: C }, A, B, isAddress).body).toEqual({ authority: A, mint: B, attester: C, minCoverageBps: 10_000, maxAgeSecs: 86_400 });
  });
  it('holds the program’s bounds: 1% to 200%, one minute to thirty days', () => {
    const f = { ...EMPTY_POLICY, attester: C };
    expect(buildPolicy({ ...f, coveragePct: '0.5' }, A, B, isAddress).errors.coveragePct).toMatch(/1 to 200/);
    expect(buildPolicy({ ...f, coveragePct: '200.01' }, A, B, isAddress).errors.coveragePct).toBeDefined();
    expect(buildPolicy({ ...f, coveragePct: '200' }, A, B, isAddress).body?.minCoverageBps).toBe(20_000);
    expect(buildPolicy({ ...f, ageValue: '59', ageUnit: 'minutes' }, A, B, isAddress).body).not.toBeNull();
    expect(buildPolicy({ ...f, ageValue: '0', ageUnit: 'minutes' }, A, B, isAddress).errors.ageValue).toMatch(/1 minute to 30 days/);
    expect(buildPolicy({ ...f, ageValue: '31', ageUnit: 'days' }, A, B, isAddress).errors.ageValue).toBeDefined();
    expect(buildPolicy({ ...f, ageValue: '30', ageUnit: 'days' }, A, B, isAddress).body?.maxAgeSecs).toBe(2_592_000);
  });
  it('builds a statement from a figure typed in tokens', () => {
    expect(buildAttest('1300', A, B, 6).body).toEqual({ attester: A, mint: B, backingAtoms: '1300000000' });
    expect(buildAttest('', A, B, 6).body).toBeNull();
    expect(buildAttest('1.0000001', A, B, 6).error).toMatch(/at most 6 decimals/);
    expect(buildAttest('1', A, B, null).error).toMatch(/decimals have not been read/);
  });
  it('writes ages and percentages as a person reads them', () => {
    expect(ageText(45)).toBe('45 seconds');
    expect(ageText(3_600)).toBe('60 minutes');
    expect(ageText(86_400)).toBe('24 hours');
    expect(ageText(10 * 86_400)).toBe('10 days');
    expect(bpsPct(10_000)).toBe('100%');
    expect(bpsPct(1_250)).toBe('12.50%');
  });
});
