import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type GraduationRead, type RoundRead, EMPTY_CHARTER, VENUES, buildCharter, buildVote, creatorStep, currentRound, humanLeft, roundLine, shareOf, shortfallText, venueLabel } from '../src/lib/graduation';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const NOW = 1_800_000_000;

const round = (o: Partial<RoundRead> = {}): RoundRead => ({
  round: C,
  index: 0,
  opensTs: String(NOW - 86_400),
  closesTs: String(NOW + 3 * 86_400),
  status: 'voting',
  quorumBps: 4_000,
  lockedTotal: '320000000',
  quorumNeeded: '400000000',
  tallies: [
    { venue: 'damm_v2', venueNumber: 0, locked: '100000000' },
    { venue: 'dlmm', venueNumber: 1, locked: '180000000' },
    { venue: 'raydium_cpmm', venueNumber: 2, locked: '0' },
    { venue: 'metadao_futarchy', venueNumber: 3, locked: '40000000' },
  ],
  volume: { required: '0', posted: null, attester: null },
  winner: null,
  wouldPassNow: false,
  ...o,
});
const read = (o: Partial<GraduationRead> = {}): GraduationRead => ({ cross: A, governed: true, release: { program: B, deployed: true }, venues: [...VENUES], outcomeAccount: C, ...o });

describe('venues', () => {
  it('are the four of the program, in its order', () => {
    const sdk = readFileSync(new URL('../../../packages/sdk/src/programs/graduate.ts', import.meta.url), 'utf8');
    expect(sdk).toContain("GRADUATE_VENUES = ['damm_v2', 'dlmm', 'raydium_cpmm', 'metadao_futarchy'] as const");
    expect(VENUES).toEqual(['damm_v2', 'dlmm', 'raydium_cpmm', 'metadao_futarchy']);
  });
  it('are named for a person, and an unknown one is not invented', () => {
    expect(venueLabel('metadao_futarchy')).toBe('MetaDAO futarchy DAO');
    expect(venueLabel(null)).toBe('no venue');
    expect(venueLabel('somewhere')).toBe('somewhere');
  });
});

describe('roundLine', () => {
  it('says when voting closes and that tokens stay locked', () => {
    expect(roundLine(round(), NOW)).toMatch(/Voting is open until .* UTC \(3d 0h left\)\. Tokens locked behind a venue stay locked/);
  });
  it('says a closed round can be finalized by anyone, and what the tally would do', () => {
    expect(roundLine(round({ status: 'awaiting-finalize', wouldPassNow: true }), NOW)).toMatch(/Anyone can finalize.*would pass/);
    expect(roundLine(round({ status: 'awaiting-finalize', wouldPassNow: false }), NOW)).toMatch(/would not pass/);
  });
  it('names the venue a passed round chose, and says a failed round leaves the market without one', () => {
    expect(roundLine(round({ status: 'passed', winner: 'dlmm' }), NOW)).toBe('The round passed and chose Meteora DLMM.');
    expect(roundLine(round({ status: 'failed' }), NOW)).toMatch(/stays without a graduation venue.*up to three/);
  });
});

describe('shortfallText', () => {
  it('names a quorum shortfall in tokens and as a share of the live supply', () => {
    expect(shortfallText(round(), 6)).toEqual(['Quorum: 320 locked of 400 needed (40% of the live supply).']);
  });
  it('names a volume gate that has no figure, and one that is below the minimum', () => {
    const base = round({ lockedTotal: '500000000', volume: { required: '5000000000', posted: null, attester: A } });
    expect(shortfallText(base, 6).join(' ')).toMatch(/no figure has been attested yet/);
    expect(shortfallText({ ...base, volume: { required: '5000000000', posted: '1200000000', attester: A } }, 6).join(' ')).toMatch(/below the charter’s minimum/);
  });
  it('names a tie, which has no winner', () => {
    const tie = round({ lockedTotal: '500000000', tallies: [{ venue: 'damm_v2', venueNumber: 0, locked: '250000000' }, { venue: 'dlmm', venueNumber: 1, locked: '250000000' }] });
    expect(shortfallText(tie, 6).join(' ')).toMatch(/no venue holds more than half/);
  });
  it('says nothing about a round that is only waiting for the window', () => {
    expect(shortfallText(round({ lockedTotal: '450000000', tallies: [{ venue: 'dlmm', venueNumber: 1, locked: '450000000' }] }), 6)).toEqual([]);
  });
});

describe('shareOf', () => {
  it('is the share of what is locked, with two decimals, and zero when nothing is locked', () => {
    expect(shareOf({ venue: 'dlmm', venueNumber: 1, locked: '180000000' }, '320000000')).toBe(56.25);
    expect(shareOf({ venue: 'dlmm', venueNumber: 1, locked: '0' }, '0')).toBe(0);
  });
});

describe('currentRound and creatorStep', () => {
  it('prefers the open round, else the latest', () => {
    const closed = round({ index: 0, status: 'failed' });
    const open = round({ index: 1, status: 'voting' });
    expect(currentRound(read({ rounds: [closed, open] }))?.index).toBe(1);
    expect(currentRound(read({ rounds: [closed] }))?.index).toBe(0);
    expect(currentRound(read())).toBeNull();
  });
  const charter = { address: C, creator: A, quorumBps: 4_000, windowSecs: '604800', minVolume: '0', volumeAttester: null, roundsUsed: 1, roundsLeft: 2, active: false, passed: false };
  it('walks the creator through the charter, the rounds and the outcome', () => {
    expect(creatorStep(read({ charter: null }))).toBe('no-charter');
    expect(creatorStep(read({ charter }))).toBe('start-round');
    expect(creatorStep(read({ charter: { ...charter, active: true } }))).toBe('round-open');
    expect(creatorStep(read({ charter: { ...charter, passed: true } }))).toBe('passed');
    expect(creatorStep(read({ charter: { ...charter, roundsLeft: 0 } }))).toBe('no-rounds-left');
  });
});

describe('buildCharter', () => {
  it('builds the defaults into basis points and seconds', () => {
    const b = buildCharter(EMPTY_CHARTER, A, B, 6);
    expect(b.body).toEqual({ creator: A, cross: B, quorumBps: 2_500, windowSecs: 7 * 86_400 });
  });
  it('holds every bound the program has: quorum 10 to 100 percent, a window of 3 to 30 days', () => {
    expect(buildCharter({ ...EMPTY_CHARTER, quorumPct: '9.99' }, A, B, 6).errors.quorumPct).toMatch(/10 to 100 percent/);
    expect(buildCharter({ ...EMPTY_CHARTER, quorumPct: '100.01' }, A, B, 6).errors.quorumPct).toBeDefined();
    expect(buildCharter({ ...EMPTY_CHARTER, quorumPct: '10' }, A, B, 6).body?.quorumBps).toBe(1_000);
    expect(buildCharter({ ...EMPTY_CHARTER, quorumPct: '100' }, A, B, 6).body?.quorumBps).toBe(10_000);
    expect(buildCharter({ ...EMPTY_CHARTER, windowDays: '2' }, A, B, 6).errors.windowDays).toMatch(/3 to 30/);
    expect(buildCharter({ ...EMPTY_CHARTER, windowDays: '31' }, A, B, 6).errors.windowDays).toBeDefined();
    expect(buildCharter({ ...EMPTY_CHARTER, windowDays: '3' }, A, B, 6).body?.windowSecs).toBe(3 * 86_400);
    expect(buildCharter({ ...EMPTY_CHARTER, windowDays: '30' }, A, B, 6).body?.windowSecs).toBe(30 * 86_400);
  });
  it('needs an attester for a volume minimum, and takes both together', () => {
    expect(buildCharter({ ...EMPTY_CHARTER, minVolume: '2500' }, A, B, 6).errors.attester).toMatch(/needs someone to attest/);
    expect(buildCharter({ ...EMPTY_CHARTER, minVolume: '2500', attester: C }, A, B, 6).body).toMatchObject({ minVolume: '2500000000', volumeAttester: C });
    expect(buildCharter({ ...EMPTY_CHARTER, attester: 'nope' }, A, B, 6).errors.attester).toMatch(/not a Solana address/);
  });
  it('builds nothing without a wallet or without the decimals of a volume it must convert', () => {
    expect(buildCharter(EMPTY_CHARTER, null, B, 6).body).toBeNull();
    expect(buildCharter({ ...EMPTY_CHARTER, minVolume: '1', attester: C }, A, B, null).body).toBeNull();
  });
});

describe('buildVote', () => {
  it('converts tokens to atoms for the venue chosen', () => {
    expect(buildVote({ venue: 'dlmm', amount: '25' }, A, B, 0, 6, 400_000_000n, null).body).toEqual({ voter: A, cross: B, venue: 'dlmm', amount: '25000000', round: 0 });
  });
  it('refuses what the program or the balance would refuse, in words', () => {
    expect(buildVote({ venue: '', amount: '1' }, A, B, 0, 6, 10n ** 9n, null).errors.venue).toMatch(/Choose the venue/);
    expect(buildVote({ venue: 'dlmm', amount: '0' }, A, B, 0, 6, 10n ** 9n, null).errors.amount).toBeDefined();
    expect(buildVote({ venue: 'dlmm', amount: '1000' }, A, B, 0, 6, 400_000_000n, null).errors.amount).toMatch(/holds 400/);
    expect(buildVote({ venue: 'dlmm', amount: '0.0000001' }, A, B, 0, 6, 400_000_000n, null).errors.amount).toMatch(/at most 6 decimals/);
  });
  it('lets a stake grow but not change venue', () => {
    const r = buildVote({ venue: 'damm_v2', amount: '1' }, A, B, 0, 6, 10n ** 9n, 'dlmm');
    expect(r.body).toBeNull();
    expect(r.errors.venue).toMatch(/cannot change venue/);
    expect(buildVote({ venue: 'dlmm', amount: '1' }, A, B, 0, 6, 10n ** 9n, 'dlmm').body).not.toBeNull();
  });
});

describe('humanLeft', () => {
  it('reads as days and hours, hours and minutes, or minutes, and never goes negative', () => {
    expect(humanLeft(3 * 86_400 + 5 * 3_600)).toBe('3d 5h');
    expect(humanLeft(2 * 3_600 + 30 * 60)).toBe('2h 30m');
    expect(humanLeft(90)).toBe('1m');
    expect(humanLeft(-5)).toBe('0m');
  });
});
