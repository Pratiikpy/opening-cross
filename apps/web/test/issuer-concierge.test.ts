import { describe, expect, it } from 'vitest';
import { type ConciergeState, concierge, elapsed, nextStep } from '../src/lib/issuer-concierge';
import { newDraft, parseDraft, serializeDraft } from '../src/lib/issuer-draft';

const empty: ConciergeState = {
  listingType: null,
  typeNeedsPartner: false,
  baseMint: { entered: false, read: 'none', blockers: 0 },
  quoteMint: { entered: false, read: 'none' },
  errors: {},
  gridFilled: false,
  minMatchedSet: false,
  guardsBlocked: false,
  rules: 'off',
  demandEntered: false,
  gate: 'none',
  walletConnected: false,
  readiness: 'unknown',
  treasury: 'not-applicable',
};
const status = (s: ConciergeState, id: string) => concierge(s).find((x) => x.id === id)!.status;

describe('concierge checklist', () => {
  it('starts with everything to do, the optional steps optional, and the after-steps later', () => {
    const steps = concierge(empty);
    expect(steps.map((x) => [x.id, x.status])).toEqual([
      ['type', 'todo'],
      ['token', 'todo'],
      ['quote', 'todo'],
      ['grid', 'todo'],
      ['window', 'done'],
      ['guards', 'todo'],
      ['rules', 'optional'],
      ['simulate', 'optional'],
      ['gate', 'optional'],
      ['wallet', 'todo'],
      ['create', 'todo'],
      ['disclosure', 'later'],
    ]);
    expect(nextStep(steps)?.id).toBe('type');
  });

  it('never marks a step done that the form or the chain has not shown', () => {
    expect(status({ ...empty, baseMint: { entered: true, read: 'none', blockers: 0 } }, 'token')).toBe('todo');
    expect(concierge({ ...empty, baseMint: { entered: true, read: 'none', blockers: 0 } }).find((x) => x.id === 'token')!.detail).toMatch(/Check mint/);
    expect(status({ ...empty, baseMint: { entered: true, read: 'failed', blockers: 0 } }, 'token')).toBe('blocked');
    expect(status({ ...empty, baseMint: { entered: true, read: 'ok', blockers: 1 } }, 'token')).toBe('blocked');
    expect(status({ ...empty, baseMint: { entered: true, read: 'ok', blockers: 0 } }, 'token')).toBe('done');
  });

  it('a field error blocks its step and no other', () => {
    const s = { ...empty, gridFilled: true, errors: { 'schedule.0': 'This price is not on the grid.' } };
    expect(status(s, 'grid')).toBe('blocked');
    expect(status(s, 'window')).toBe('done');
    expect(status({ ...s, errors: { closeAt: 'x' } }, 'window')).toBe('blocked');
  });

  it('the create step opens only when every required step is done', () => {
    const ready: ConciergeState = {
      ...empty,
      listingType: 'ownership-coin',
      baseMint: { entered: true, read: 'ok', blockers: 0 },
      quoteMint: { entered: true, read: 'ok' },
      gridFilled: true,
      minMatchedSet: true,
      walletConnected: true,
      readiness: 'ready',
    };
    expect(status(ready, 'create')).toBe('current');
    expect(status({ ...ready, readiness: 'failing' }, 'create')).toBe('todo');
    expect(status({ ...ready, walletConnected: false, readiness: 'unknown' }, 'create')).toBe('todo');
    expect(status({ ...ready, guardsBlocked: true }, 'create')).toBe('todo');
    expect(status({ ...ready, typeNeedsPartner: true }, 'create')).toBe('blocked');
  });

  it('a licensed-partner type is blocked at the first step, and says so', () => {
    const s = { ...empty, listingType: 'pre-ipo' as const, typeNeedsPartner: true };
    expect(status(s, 'type')).toBe('blocked');
    expect(nextStep(concierge(s))?.id).toBe('type');
  });

  it('a treasury step appears after the cross only for the types that want one', () => {
    expect(concierge(empty).some((x) => x.id === 'treasury')).toBe(false);
    const t = concierge({ ...empty, treasury: 'recommended' }).find((x) => x.id === 'treasury')!;
    expect(t.status).toBe('later');
    expect(t.why).toMatch(/supply is fixed/);
  });

  it('an unfinished gate blocks, a finished one is done, none is optional', () => {
    expect(status({ ...empty, gate: 'incomplete' }, 'gate')).toBe('blocked');
    expect(status({ ...empty, gate: 'complete' }, 'gate')).toBe('done');
    expect(status(empty, 'gate')).toBe('optional');
  });
});

describe('elapsed', () => {
  it('reads minutes then hours', () => {
    expect(elapsed(0)).toBe('0 min');
    expect(elapsed(61_000)).toBe('1 min');
    expect(elapsed(59 * 60_000)).toBe('59 min');
    expect(elapsed(65 * 60_000)).toBe('1 h 05 min');
    expect(elapsed(-5)).toBe('0 min');
  });
});

describe('draft storage', () => {
  const now = new Date('2026-10-13T12:00:00');
  it('round-trips a draft exactly', () => {
    const d = { ...newDraft(now), baseMint: 'B', listingType: 'ownership-coin' as const, minMatched: '5', schedule: [{ price: '1.20', quantity: '100' }, { price: '1.50', quantity: '9' }] };
    expect(parseDraft(serializeDraft(d), newDraft(now))).toEqual(d);
  });
  it('a half-typed number field (NaN) is stored as null and comes back as the default', () => {
    const d = { ...newDraft(now), ticks: Number.NaN };
    const back = parseDraft(serializeDraft(d), newDraft(now));
    expect(back?.ticks).toBe(40);
  });
  it('drops anything that is not a draft this version wrote', () => {
    const fallback = newDraft(now);
    const good = JSON.parse(serializeDraft(fallback));
    expect(parseDraft(null, fallback)).toBeNull();
    expect(parseDraft('', fallback)).toBeNull();
    expect(parseDraft('not json', fallback)).toBeNull();
    expect(parseDraft('[]', fallback)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...good, disclosure: 'secret' }), fallback)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...good, listingType: 'moonshot' }), fallback)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...good, schedule: [{ price: 1, quantity: 2 }] }), fallback)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...good, oracle: null }), fallback)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...good, baseMint: 7 }), fallback)).toBeNull();
    const { maxFdv: _drop, ...missing } = good;
    expect(parseDraft(JSON.stringify(missing), fallback)).toBeNull();
  });
  it('a new draft opens an hour from now and closes two hours later', () => {
    const d = newDraft(now);
    expect(new Date(d.closeAt).getTime() - new Date(d.openAt).getTime()).toBe(2 * 3_600_000);
    expect(new Date(d.openAt).getTime() - now.getTime()).toBe(3_600_000);
  });
});

describe('the rules step', () => {
  it('is optional when off, blocks creation while refused, and is done only when the rules are accepted', () => {
    expect(status(empty, 'rules')).toBe('optional');
    expect(status({ ...empty, rules: 'pending' }, 'rules')).toBe('todo');
    expect(status({ ...empty, rules: 'invalid' }, 'rules')).toBe('blocked');
    expect(status({ ...empty, rules: 'valid' }, 'rules')).toBe('done');
    const ready: ConciergeState = { ...empty, listingType: 'launch' as never, baseMint: { entered: true, read: 'ok', blockers: 0 }, quoteMint: { entered: true, read: 'ok' }, gridFilled: true, minMatchedSet: true, walletConnected: true, readiness: 'ready' };
    expect(status({ ...ready, rules: 'valid' }, 'create')).toBe('current');
    expect(status({ ...ready, rules: 'pending' }, 'create')).toBe('todo');
    expect(status({ ...ready, rules: 'invalid' }, 'create')).toBe('todo');
  });
});
