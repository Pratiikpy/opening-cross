import { describe, expect, it } from 'vitest';
import { EMPTY_GATE, type GatePresetView, summarize } from '../src/lib/gate-field';
import { REASON_TITLE, REASON_TONE } from '../src/lib/gate';

const MINT = '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr';
const ROOT = 'ab'.repeat(32);

const open: GatePresetView = { id: 'open', name: 'Open', summary: 's', gatedCross: false, mode: null, passRoute: 'none', issuerBrings: [], issuerSteps: [], walletDoes: 'x', limits: [] };
const allowlist: GatePresetView = { ...open, id: 'allowlist', gatedCross: true, mode: 'Allowlist', passRoute: 'allowlist-proof', issuerBrings: ['gate-mint', 'allowlist'] };
const attested: GatePresetView = { ...open, id: 'attested-wallet', gatedCross: true, mode: 'Allowlist', passRoute: 'sas-attestation', issuerBrings: ['gate-mint', 'sas-credential-and-schema'] };

describe('gate field summary', () => {
  it('open needs nothing and creates the cross without a gate mint', () => {
    expect(summarize(EMPTY_GATE, open, null)).toEqual({ gateMint: null, allowlistRoot: null, complete: true, missing: [] });
  });

  it('allowlist needs a valid gate mint and a root from at least one valid address', () => {
    expect(summarize({ ...EMPTY_GATE, preset: 'allowlist' }, allowlist, null).missing).toHaveLength(2);
    expect(summarize({ ...EMPTY_GATE, preset: 'allowlist', gateMint: 'not a mint' }, allowlist, ROOT).missing).toEqual([expect.stringMatching(/gate mint/)]);
    expect(summarize({ ...EMPTY_GATE, preset: 'allowlist', gateMint: ` ${MINT} ` }, allowlist, null).missing).toEqual([expect.stringMatching(/wallet address/)]);
    expect(summarize({ ...EMPTY_GATE, preset: 'allowlist', gateMint: MINT }, allowlist, ROOT)).toEqual({ gateMint: MINT, allowlistRoot: ROOT, complete: true, missing: [] });
  });

  it('attested wallet needs the credential and schema as addresses', () => {
    const v = { ...EMPTY_GATE, preset: 'attested-wallet' as const, gateMint: MINT };
    expect(summarize(v, attested, null).missing).toEqual([expect.stringMatching(/credential and schema/)]);
    expect(summarize({ ...v, credential: MINT, schema: 'x' }, attested, null).complete).toBe(false);
    expect(summarize({ ...v, credential: MINT, schema: MINT }, attested, null)).toMatchObject({ complete: true, gateMint: MINT, allowlistRoot: null });
  });

  it('with no preset loaded it is never complete', () => {
    expect(summarize(EMPTY_GATE, undefined, null).complete).toBe(false);
  });
});

describe('reason wording', () => {
  it('every reason code has a title and a tone', () => {
    expect(Object.keys(REASON_TITLE).sort()).toEqual(Object.keys(REASON_TONE).sort());
    expect(Object.keys(REASON_TITLE)).toHaveLength(11);
  });
});
