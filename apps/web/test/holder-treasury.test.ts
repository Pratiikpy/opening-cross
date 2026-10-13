import { describe, expect, it } from 'vitest';
import { releaseOf } from '../src/lib/holder-programs';
import {
  type ExtRead,
  type Position,
  type Proposal,
  availability,
  disclosureView,
  proposalActions,
  shareBps,
  termsLines,
  yesShare,
} from '../src/lib/holder-treasury';

type Ext = Extract<ExtRead, { extended: true }>;
const WALLET = '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT';
const DAY = 86_400;

const ext = (over: Partial<Ext['terms']> = {}, live: Partial<Ext['live']> = {}): Ext => ({
  treasury: 'T',
  extended: true,
  state: 'active',
  terms: {
    governance: { votePeriodSecs: String(3 * DAY), timelockSecs: String(DAY), quorumBps: 2000, thresholdBps: 5000, maxProposalBps: 5000, proposerMinBps: 100 },
    nav: { periodSecs: String(7 * DAY), capBps: 1000, insiders: [] },
    distributions: { streamSecs: '0' },
    revenue: { shareBps: 1000, credential: 'c', schema: 's', roundSecs: String(7 * DAY), start: '0', payGraceSecs: String(3 * DAY), trancheMinRevenue: '0', trancheAmount: '0' },
    grants: { minLockupSecs: String(90 * DAY) },
    disclosure: { periodSecs: String(14 * DAY), requestMinBps: 100 },
    assignment: null,
    windDown: { windowSecs: String(180 * DAY), recovery: 'r' },
    ...over,
  },
  live: { proposals: '0', votesLocked: '0', totalStaked: '0', grants: '0', grantsUnreleased: '0', navOpen: false, navPeriod: null, missedRounds: 0, currentRound: null, stream: null, disclosures: 0, lastDisclosureAt: null, disclosureRequestOpenSince: null, disclosureDeadline: null, assigned: null, windDown: null, ...live },
  balances: { vault: '10000000000', coinVault: '0', distVault: '0', coinSupply: '1000000000' },
});

describe('releaseOf and availability', () => {
  const report = (extended: boolean | null) => ({ address: 'x', deployedSlot: '1', extended, checked: [], note: '' });
  it('never turns "could not tell" into "first release"', () => {
    expect(releaseOf(report(null))).toBe('unknown');
    expect(releaseOf(null)).toBe('unknown');
    expect(releaseOf(report(false))).toBe('first-release');
    expect(releaseOf(report(true))).toBe('extended');
  });
  it('offers nothing on the first release, whatever the treasury looks like', () => {
    expect(availability('first-release', ext())).toEqual({ kind: 'first-release' });
    expect(availability('first-release', null)).toEqual({ kind: 'first-release' });
  });
  it('is live only when the program has the extension and the treasury was extended', () => {
    expect(availability('extended', ext())).toEqual({ kind: 'live' });
    expect(availability('extended', { treasury: 'T', extended: false, note: '' })).toEqual({ kind: 'not-extended' });
    expect(availability('unknown', ext())).toEqual({ kind: 'live' });
    expect(availability('unknown', { treasury: 'T', extended: false, note: '' })).toEqual({ kind: 'unknown', extended: false });
    expect(availability('extended', null)).toEqual({ kind: 'unknown', extended: false });
  });
});

describe('termsLines', () => {
  it('describes each feature the team switched on, from the fixed terms', () => {
    const text = termsLines(ext()).map((l) => l.text).join('\n');
    expect(text).toMatch(/at least 1% of the supply can propose.*3 days.*at least 20% of the supply voting.*strict majority above 50%.*timelock of 1 day.*at most 50% of the vault/s);
    expect(text).toMatch(/Redemption at NAV.*7 days.*at most 10% of the supply.*Insiders cannot redeem/s);
    expect(text).toMatch(/Distributions.*Unstaking is never blocked/s);
    expect(text).toMatch(/owes 10% of attested revenue to stakers each 7 days.*3 days to pay/s);
    expect(text).toMatch(/Disclosure requests.*1% of the supply.*14 days/s);
    expect(text).toMatch(/Wind-down.*180 days/s);
  });
  it('leaves out a feature the team left off', () => {
    const lines = termsLines(ext({ governance: null, nav: null, revenue: null, disclosure: null, windDown: null })).map((l) => l.id);
    expect(lines).toEqual(['dist', 'grants']);
  });
});

describe('proposalActions', () => {
  const p = (over: Partial<Proposal> = {}): Proposal => ({ id: '0', proposer: WALLET, kind: 'spend', amount: '1', destination: null, descHash: '', createdAt: '0', voteEndsAt: '2000', executableAt: '3000', expiresAt: '9000', yes: '0', no: '0', quorumNeeded: '1', status: 'voting', ...over });
  const pos = (held: string): Position => ({ treasury: 'T', owner: WALLET, held, staked: '0', claimable: '0', totalStaked: '0' });
  it('offers a vote while voting is open, enabled only for a holder', () => {
    expect(proposalActions(p(), pos('5'), false, 1000n)).toEqual([{ id: 'vote', proposal: expect.anything(), enabled: true, why: null }]);
    const none = proposalActions(p(), pos('0'), false, 1000n);
    expect(none[0]).toMatchObject({ id: 'vote', enabled: false, why: expect.stringMatching(/holds no coins/) });
    expect(proposalActions(p(), null, false, 1000n)[0]).toMatchObject({ enabled: false });
  });
  it('offers the reclaim only after voting ends, and only to a wallet that voted', () => {
    expect(proposalActions(p({ status: 'failed' }), pos('5'), true, 2500n).map((a) => a.id)).toEqual(['reclaim-vote']);
    expect(proposalActions(p({ status: 'failed' }), pos('5'), false, 2500n)).toEqual([]);
    expect(proposalActions(p(), pos('5'), true, 1500n).map((a) => a.id)).toEqual(['vote']);
  });
  it('offers execution to anyone once the proposal is executable, and not before or after', () => {
    expect(proposalActions(p({ status: 'executable' }), pos('0'), false, 3500n).map((a) => a.id)).toEqual(['execute']);
    for (const status of ['timelock', 'failed', 'expired', 'executed'] as const) expect(proposalActions(p({ status }), pos('0'), false, 3500n).map((a) => a.id)).not.toContain('execute');
  });
});

describe('yesShare and shareBps', () => {
  it('rounds down to a tenth of a percent and says nothing when nobody voted', () => {
    expect(yesShare({ yes: '2', no: '1' })).toBe('66.6%');
    expect(yesShare({ yes: '0', no: '0' })).toBeNull();
  });
  it('is zero for an empty supply', () => {
    expect(shareBps(5n, 0n)).toBe(0n);
    expect(shareBps(10n, 1000n)).toBe(100n);
  });
});

describe('disclosureView', () => {
  it('is not enabled when the team did not switch it on', () => {
    expect(disclosureView(ext({ disclosure: null }), 100n, 10n)).toMatchObject({ state: 'not-enabled', canRequest: false });
  });
  it('lets a holder of enough of the supply request, and says what is short otherwise', () => {
    expect(disclosureView(ext(), 10_000_000n, 10n)).toMatchObject({ state: 'open', canRequest: true });
    const short = disclosureView(ext(), 5_000_000n, 10n);
    expect(short).toMatchObject({ canRequest: false });
    expect(short.why).toMatch(/holds 0\.5% of the supply; the minimum is 1%/);
  });
  it('shows an open request with its deadline, and when it is overdue', () => {
    const e = ext({}, { disclosureRequestOpenSince: '1000', disclosureDeadline: '5000' });
    expect(disclosureView(e, 10_000_000n, 2000n)).toMatchObject({ state: 'requested', canRequest: false });
    expect(disclosureView(e, 10_000_000n, 6000n)).toMatchObject({ state: 'overdue', text: expect.stringMatching(/refuses team outflows/) });
  });
});
