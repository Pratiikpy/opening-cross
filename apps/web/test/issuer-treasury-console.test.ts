import { describe, expect, it } from 'vitest';
import { EMPTY_TERMS, TERMS_PRESETS, type TermsForm, applyTermsPreset, cloneTerms } from '@opening-cross/presets/treasury';
import { atomsOf, buildTerms, pctOf, sha256Hex, termsKeyForIssue } from '../src/lib/issuer-treasury-console';
import { knownPrograms, readSimulation, releaseOf, unknownReleaseSentence } from '../src/lib/issuer-programs';

const AUTH = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const form = (o: Partial<TermsForm>): TermsForm => ({ ...cloneTerms(EMPTY_TERMS), ...o });

describe('buildTerms', () => {
  it('converts days, hours and percent exactly for a custom set, and sends only what is set', () => {
    const b = buildTerms(form({ votePeriodDays: '7', timelockDays: '2', quorumPct: '20', thresholdPct: '50', streamHours: '168', windowDays: '365', recovery: A, insiders: [B, ''] }), 'custom', AUTH, 6);
    expect(b.errors).toEqual({});
    expect(b.body).toEqual({ authority: AUTH, params: { votePeriodSecs: 604_800, timelockSecs: 172_800, quorumBps: 2000, thresholdBps: 5000, insiders: [B], streamSecs: 604_800, windowSecs: 31_536_000, recovery: A } });
  });
  it('turns quote amounts into atoms and refuses ones that would round', () => {
    const ok = buildTerms(form({ revSharePct: '10', trancheAmount: '100.5' }), 'custom', AUTH, 6);
    expect((ok.body!.params as Record<string, unknown>).trancheAmount).toBe('100500000');
    expect(buildTerms(form({ trancheAmount: '0.0000001' }), 'custom', AUTH, 6).errors.trancheAmount).toMatch(/6 decimal places/);
    expect(buildTerms(form({ trancheAmount: '1' }), 'custom', AUTH, null).errors.trancheAmount).toMatch(/not been read/);
  });
  it('names every field it cannot read, and will not send an empty extension', () => {
    const b = buildTerms(form({ votePeriodDays: '1.5', quorumPct: '120', recovery: 'x', insiders: ['nope'] }), 'custom', AUTH, 6);
    expect(Object.keys(b.errors).sort()).toEqual(['insiders.0', 'quorumPct', 'recovery', 'votePeriodDays']);
    expect(b.body).toBeNull();
    expect(buildTerms(cloneTerms(EMPTY_TERMS), 'custom', AUTH, 6).body).toBeNull();
  });
  it('says a wind-down needs its recovery account before any request is made', () => {
    const b = buildTerms(applyTermsPreset(TERMS_PRESETS.find((p) => p.id === 'governed')!), 'custom', AUTH, 6);
    expect(b.body).toBeNull();
    expect(b.errors.recovery).toMatch(/names the account/);
  });
  it('builds the flagship request from its own inputs only', () => {
    const f = form({ revSharePct: '10', revCredential: A, revSchema: B, assignCredential: A, assignSchema: B, recovery: A, revStart: '2030-01-01T00:00', insiders: [B] });
    const b = buildTerms(f, 'flagship', AUTH, 6);
    expect(b.errors).toEqual({});
    expect(b.body).toMatchObject({ authority: AUTH, preset: 'flagship', revenueShareBps: 1000, revenueCredential: A, assignmentSchema: B, recovery: A, insiders: [B] });
    expect(typeof (b.body as { revenueStart: number }).revenueStart).toBe('number');
    const missing = buildTerms(form({ revSharePct: '10' }), 'flagship', AUTH, 6);
    expect(Object.keys(missing.errors).sort()).toEqual(['assignCredential', 'assignSchema', 'recovery', 'revCredential', 'revSchema', 'revStart']);
  });
});

describe('small pieces', () => {
  it('maps the program’s parameter names to the boxes', () => {
    expect(termsKeyForIssue('quorumBps')).toBe('quorumPct');
    expect(termsKeyForIssue('windowSecs')).toBe('windowDays');
    expect(termsKeyForIssue('nothing')).toBeNull();
  });
  it('reads amounts and hashes text', async () => {
    expect(atomsOf('1.5', 6, 'x')).toEqual({ ok: true, atoms: '1500000' });
    expect(atomsOf('0', 6, 'x')).toMatchObject({ ok: false });
    expect(atomsOf('0', 6, 'x', { allowZero: true })).toEqual({ ok: true, atoms: '0' });
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(pctOf(2000)).toBe('20%');
    expect(pctOf(125)).toBe('1.25%');
  });
});

describe('the release of a program and the dry run', () => {
  const logs101 = ['Program P invoke [1]', 'Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101.', 'Program P failed: custom program error: 0x65'];
  it('never turns an unread program into a first release', () => {
    expect(releaseOf(null)).toBe('unknown');
    expect(releaseOf({ address: 'x', deployedSlot: null, extended: null, checked: [], note: '' })).toBe('unknown');
    expect(releaseOf({ address: 'x', deployedSlot: '1', extended: false, checked: [], note: '' })).toBe('first-release');
    expect(releaseOf({ address: 'x', deployedSlot: '1', extended: true, checked: [], note: '' })).toBe('extended');
  });
  it('reads a simulation in words', () => {
    expect(readSimulation({ err: null, logs: [] })).toEqual({ ok: true });
    const missing = readSimulation({ err: { InstructionError: [0, { Custom: 101 }] }, logs: logs101 }, { P: 'the treasury program' });
    expect(missing).toMatchObject({ ok: false, kind: 'missing-instruction' });
    expect((missing as { message: string }).message).toMatch(/cluster’s treasury program does not have this instruction yet.*H27.*Nothing was signed/);
    expect(readSimulation({ err: { InstructionError: [0, { Custom: 101 }] }, logs: logs101 }, {}, 'cross_settle')).toMatchObject({ message: expect.stringMatching(/cluster’s cross_settle does not/) });
    expect(readSimulation({ err: { InstructionError: [0, { Custom: 6005 }] }, logs: ['Program log: AnchorError occurred. Error Code: NotAttested. Error Number: 6005. Error Message: No live attestation for this treasury.'] })).toMatchObject({ ok: false, kind: 'refused', message: expect.stringMatching(/No live attestation/) });
    expect(readSimulation({ err: 'AccountNotFound', logs: [] })).toMatchObject({ ok: 'unknown' });
    expect(readSimulation({ err: 'InsufficientFundsForFee', logs: [] })).toMatchObject({ ok: false });
  });
  it('names programs only from what the API reported', () => {
    expect(knownPrograms(null)).toEqual({});
    expect(knownPrograms({ checkedAt: 1, programs: { crossCore: { address: 'CC', deployedSlot: null, extended: true, checked: [], note: '' }, treasury: { address: 'TT', deployedSlot: null, extended: true, checked: [], note: '' } } })).toEqual({ CC: 'cross_core', TT: 'the treasury program' });
    expect(unknownReleaseSentence('x', 'not-reported')).toMatch(/does not report/);
    expect(unknownReleaseSentence('x', 'unavailable')).toMatch(/could not ask/);
  });
});
