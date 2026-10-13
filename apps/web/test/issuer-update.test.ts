import { describe, expect, it } from 'vitest';
import { type UpdateDeps, type UpdateForm, checkUpdateForm, dayStart, postUpdate } from '../src/lib/issuer-update';
import { parseAtoms } from '../src/lib/units';

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0) / 1000;
const form = (o: Partial<UpdateForm> = {}): UpdateForm => ({ title: 'October', summary: 'We shipped.', coveredFrom: '2026-10-01', coveredTo: '2026-10-12', declaredSpent: '250.5', ...o });

describe('dayStart', () => {
  it('reads a calendar day as the start of that day in UTC and refuses anything else', () => {
    expect(dayStart('2026-10-01')).toBe(Date.UTC(2026, 9, 1) / 1000);
    for (const bad of ['2026-02-30', '2026-13-01', '10/01/2026', '', 'x']) expect(dayStart(bad), bad).toBeNull();
  });
});

describe('checkUpdateForm', () => {
  it('turns the form into the prepare request, converting the declared figure exactly', () => {
    const r = checkUpdateForm(form(), 6, parseAtoms, NOW);
    expect(r.ok && r.body).toEqual({ title: 'October', summary: 'We shipped.', coveredFrom: Date.UTC(2026, 9, 1) / 1000, coveredTo: Date.UTC(2026, 9, 12) / 1000 + 86_399, declaredSpentAtoms: '250500000' });
  });
  it('caps a span that ends today at the present, because an update cannot cover time not yet passed', () => {
    const r = checkUpdateForm(form({ coveredTo: '2026-10-13' }), 6, parseAtoms, NOW);
    expect(r.ok && r.body.coveredTo).toBe(NOW - 1);
  });
  it('refuses days that have not started and a reversed span', () => {
    expect(checkUpdateForm(form({ coveredFrom: '2026-10-14', coveredTo: '2026-10-14' }), 6, parseAtoms, NOW)).toMatchObject({ ok: false, errors: { coveredFrom: expect.stringMatching(/not started/) } });
    expect(checkUpdateForm(form({ coveredFrom: '2026-10-05', coveredTo: '2026-10-01' }), 6, parseAtoms, NOW)).toMatchObject({ ok: false, errors: { coveredTo: expect.stringMatching(/before the first/) } });
  });
  it('leaves the declared figure out when empty and refuses one that would round', () => {
    const r = checkUpdateForm(form({ declaredSpent: '' }), 6, parseAtoms, NOW);
    expect(r.ok && r.body.declaredSpentAtoms).toBeNull();
    expect(checkUpdateForm(form({ declaredSpent: '1.0000001' }), 6, parseAtoms, NOW).ok).toBe(false);
    expect(checkUpdateForm(form({ declaredSpent: '5' }), null, parseAtoms, NOW).ok).toBe(false);
  });
  it('names an empty title, an empty summary and a too-long title', () => {
    const r = checkUpdateForm(form({ title: ' ', summary: '', coveredFrom: '' }), 6, parseAtoms, NOW);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['coveredFrom', 'summary', 'title']);
    expect(checkUpdateForm(form({ title: 'x'.repeat(121) }), 6, parseAtoms, NOW).ok).toBe(false);
  });
});

describe('postUpdate', () => {
  const prepared = { body: { sequence: 3, treasury: 'T' }, id: 'a'.repeat(64), message: 'domain\nid', memoText: 'memo' };
  const calls: string[] = [];
  const deps = (o: Partial<UpdateDeps> = {}): UpdateDeps => ({
    prepare: async (b) => (calls.push(`prepare ${String(b.authority)}`), { ok: true, data: prepared }),
    signMessage: async (m) => (calls.push(`sign ${m}`), 'ab'.repeat(64)),
    memoTx: async (b) => (calls.push(`memo ${String(b.sequence)} ${String(b.id).slice(0, 4)}`), { ok: true, txs: [{ transaction: 'x', signers: ['W'] }] }),
    send: async () => (calls.push('send'), ['MEMOSIG']),
    submit: async (t, b) => (calls.push(`submit ${t} ${(b.update as { signer: string }).signer} ${String(b.memoSignature)}`), { ok: true, data: {} }),
    ...o,
  });
  const run = (o: Partial<UpdateDeps> = {}) => {
    calls.length = 0;
    return postUpdate('T', 'W', { title: 't' }, deps(o), () => undefined);
  };

  it('runs prepare, sign, anchor, publish in that order and returns the anchor', async () => {
    const r = await run();
    expect(r).toEqual({ ok: true, id: prepared.id, sequence: 3, memoSignature: 'MEMOSIG' });
    expect(calls).toEqual(['prepare W', 'sign domain\nid', 'memo 3 aaaa', 'send', 'submit T W MEMOSIG']);
  });
  it('stops at the first failure and says which step and whether anything is on chain', async () => {
    expect(await run({ prepare: async () => ({ ok: false, error: 'Only the authority' }) })).toMatchObject({ ok: false, step: 'prepare', anchored: null });
    expect(calls).toEqual([]);
    const declined = await run({ signMessage: async () => { throw new Error('User rejected the request.'); } });
    expect(declined).toMatchObject({ ok: false, step: 'sign', error: expect.stringMatching(/Nothing was published/), anchored: null });
    expect(calls).not.toContain('send');
    const noMemo = await run({ send: async () => { throw new Error('The transaction failed on chain'); } });
    expect(noMemo).toMatchObject({ ok: false, step: 'anchor', anchored: null });
    expect(calls).not.toContain('submit');
  });
  it('a refused publish after the memo landed reports the anchor, so nobody retries blind', async () => {
    const r = await run({ submit: async () => ({ ok: false, error: 'the update does not verify' }) });
    expect(r).toMatchObject({ ok: false, step: 'publish', anchored: 'MEMOSIG', error: 'the update does not verify' });
  });
});
