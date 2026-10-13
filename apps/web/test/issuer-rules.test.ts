import { describe, expect, it } from 'vitest';
import { EMPTY_RULES_FORM, RULE_PRESETS, type RulesForm, applyRulePreset, cloneRulesForm, rulesFormIsEmpty } from '@opening-cross/presets/rules';
import { newDraft, parseDraft, serializeDraft } from '../src/lib/issuer-draft';
import { FLAGS, TRANSACTION_LIMIT, bidderView, buildRules, formKeyForIssue, measureCreation, rulesBodyPart, sizeStatement } from '../src/lib/issuer-rules';
import type { Market } from '../src/lib/units';

const market: Market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
const units = { baseDecimals: 6, quoteDecimals: 6, market };
const form = (over: Partial<RulesForm>): RulesForm => ({ ...cloneRulesForm(EMPTY_RULES_FORM), ...over });
const WALLET = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const OTHER = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const FEED = 'ab'.repeat(32);

describe('buildRules', () => {
  it('builds nothing for an empty form, so the cross is created without the extension', () => {
    const b = buildRules(cloneRulesForm(EMPTY_RULES_FORM), units);
    expect(b).toMatchObject({ active: false, json: null });
    expect(rulesBodyPart(b)).toEqual({});
    expect(rulesFormIsEmpty(form({ insiders: [' '] }))).toBe(true);
    expect(rulesFormIsEmpty(form({ drawnEnd: true }))).toBe(false);
  });

  it('converts every unit exactly: minutes, days, percent, tokens, ratios and prices', () => {
    const b = buildRules(
      form({
        endingMins: '30', buckets: '6', drawnEnd: true, cancelCutoffMins: '15', extensionMinMins: '5', extensionMaxMins: '60',
        minRaise: '1000.5', maxDelivered: '2500', declaredSupply: '10000000', minFloatPct: '12.5', maxFdvRatio: '20.25', movePct: '20', anchorPrice: '1.25',
        standardGrid: true, gridEstimate: '1.3', guardScaledUi: true, resumesHalt: true, haltSource: WALLET, feedsLenders: true, calendar: OTHER,
        identityCap: '500', identityMaxOrders: '1',
        reserveSmallPct: '20', reserveLockedPct: '30', reservePriorityPct: '10', smallCap: '250', lotteryLot: '100', minLockDays: '90', lockVestDays: '90', earlyUntil: '2030-01-01T12:00', priorityGate: OTHER, class1CliffDays: '30', class1VestDays: '60',
        insiders: [WALLET, '', OTHER], insiderCliffDays: '180', insiderVestDays: '365', bond: '50', challengeDays: '7',
        extraFeeds: [FEED, ''], quorum: '2', maxSpreadPct: '1.5', offHoursWidenPct: '5',
        referrer: OTHER, referralSharePct: '25',
      }),
      units,
    );
    expect(b.errors).toEqual({});
    expect(b.calendar).toBe(OTHER);
    const j = b.json!;
    expect(j.flags).toBe(FLAGS.resumesHalt | FLAGS.feedsLenders | FLAGS.standardGrid | FLAGS.guardScaledUi);
    expect(j.ending).toEqual({ endingSecs: 1800, buckets: 6, cancelCutoffSecs: 900, randomEnd: true, extensionMinSecs: 300, extensionMaxSecs: 3600 });
    expect(j.guards).toEqual({ minRaiseQuote: '1000500000', maxMatched: '2500000000', totalSupply: '10000000000000', minFloatBps: 1250, maxFdvX100: 2025, anchorPrice: '1250000', moveBps: 2000, gridEstimate: '1300000', haltSource: WALLET });
    expect(j.identity).toEqual({ capQuote: '500000000', maxOrders: 1 });
    expect(j.alloc).toMatchObject({ reserveBps: [2000, 3000, 1000], smallCapQuote: '250000000', lotteryUnit: '100000000', minLockSecs: 90 * 86_400, lockVestSecs: 90 * 86_400, priorityGate: OTHER, class1CliffSecs: 30 * 86_400, class1VestSecs: 60 * 86_400 });
    expect(j.alloc!.earlyUntilTs).toBe(String(Math.floor(new Date('2030-01-01T12:00').getTime() / 1000)));
    expect(j.neutrality).toEqual({ insiders: [WALLET, OTHER], insiderCliffSecs: 180 * 86_400, insiderVestSecs: 365 * 86_400, bondQuote: '50000000', challengeSecs: 7 * 86_400 });
    expect(j.oracleSet).toEqual({ extraFeeds: [FEED], quorum: 2, maxSpreadBps: 150, offHoursWidenBps: 500 });
    expect(j.referral).toEqual({ referrer: OTHER, shareBps: 2500 });
  });

  it('sends only the rules that are set, and a reserve share left empty counts as zero', () => {
    const j = buildRules(form({ reserveLockedPct: '30', minLockDays: '90' }), units).json!;
    expect(Object.keys(j)).toEqual(['alloc']);
    expect(j.alloc).toEqual({ reserveBps: [0, 3000, 0], minLockSecs: 90 * 86_400 });
  });

  it('names every field it cannot read and sends nothing wrong for it', () => {
    const b = buildRules(form({ endingMins: '1.5', buckets: 'six', minRaise: '1.0000001', minFloatPct: '120', maxFdvRatio: 'x', movePct: '-1', insiders: ['nope'], extraFeeds: ['abc'], referrer: 'x', earlyUntil: 'tomorrow', haltSource: '123' }), units);
    expect(Object.keys(b.errors).sort()).toEqual(['buckets', 'earlyUntil', 'endingMins', 'extraFeeds.0', 'haltSource', 'insiders.0', 'maxFdvRatio', 'minFloatPct', 'minRaise', 'movePct', 'referrer'].sort());
    expect(b.errors.minRaise).toMatch(/6 decimal places/);
    expect(JSON.stringify(b.json)).not.toMatch(/Infinity|NaN|undefined/);
  });

  it('cannot read an amount before the token it is measured in has been read', () => {
    const b = buildRules(form({ minRaise: '10', maxDelivered: '5', gridEstimate: '1.2' }), { baseDecimals: null, quoteDecimals: null, market: null });
    expect(b.errors.minRaise).toMatch(/quote token first/);
    expect(b.errors.maxDelivered).toMatch(/token being sold first/);
    expect(b.errors.gridEstimate).toMatch(/both tokens first/);
  });

  it('turns every preset into rules, and none of them picks an amount that belongs to the token', () => {
    for (const p of RULE_PRESETS) {
      const f = applyRulePreset(p);
      const b = buildRules(f, units);
      expect(b.errors, p.id).toEqual({});
      expect(b.active, p.id).toBe(p.id !== 'none');
      for (const k of p.yoursToFill) {
        const v = f[k];
        expect(Array.isArray(v) ? v.every((x) => x === '') : v === '' || v === false, `${p.id} leaves ${k} to the issuer`).toBe(true);
      }
      for (const k of ['minRaise', 'maxDelivered', 'declaredSupply', 'smallCap', 'bond', 'identityCap', 'anchorPrice', 'gridEstimate'] as const) expect(f[k], `${p.id}.${k}`).toBe('');
    }
    expect(applyRulePreset(RULE_PRESETS.find((p) => p.id === 'hard-to-game-ending')!).drawnEnd).toBe(true);
  });
});

describe('formKeyForIssue', () => {
  it('maps the field of an issue to the box that holds it, lists and all', () => {
    expect(formKeyForIssue('ending.buckets')).toBe('buckets');
    expect(formKeyForIssue('neutrality.insiders[3]')).toBe('insiders');
    expect(formKeyForIssue('oracleSet.extraFeeds[1]')).toBe('extraFeeds');
    expect(formKeyForIssue('rules')).toBeNull();
  });
});

describe('bidderView', () => {
  const ctx = { baseDecimals: 6, quoteDecimals: 6, openMs: Date.UTC(2030, 0, 1, 0, 0), closeMs: Date.UTC(2030, 0, 1, 2, 0) };
  it('says nothing when there are no rules', () => {
    expect(bidderView(null, ctx)).toEqual([]);
  });
  it('says what the committed rules do, in the words of the mechanism', () => {
    const j = buildRules(form({ endingMins: '30', buckets: '6', drawnEnd: true, cancelCutoffMins: '30', reserveSmallPct: '20', smallCap: '250', minFloatPct: '15', bond: '50', insiders: [WALLET], challengeDays: '7', minRaise: '1000' }), units).json!;
    const v = Object.fromEntries(bidderView(j, ctx).map((x) => [x.id, x]));
    expect(v.ending!.title).toBe('Final 30 minutes: 6 buckets');
    expect(v.ending!.text).toMatch(/draws which bucket is the last one counted/);
    expect(v.ending!.text).toMatch(/nearest price band/);
    expect(v.cancel!.text).toMatch(/until 2030-01-01 01:00 UTC, 1 hour before the close/);
    expect(v['class-small']!.title).toBe('Small verified buyers: 20% reserved');
    expect(v['class-small']!.text).toMatch(/250 quote/);
    expect(v['min-raise']!.title).toBe('Prints only if it raises 1,000 quote');
    expect(v.float!.title).toBe('Public float of at least 15%');
    expect(v.insiders!.title).toBe('1 declared insider');
    expect(v.bond!.text).toMatch(/7 days/);
  });
});

describe('the size of the creation', () => {
  it('says plainly when it is one transaction and when it is two', () => {
    const one = sizeStatement({ ok: true, cross: 'x', transactions: 6, sizes: { createAndRules: 900, withPrefix: 1100, firstTransactions: 1 } });
    expect(one.tone).toBe('ok');
    expect(one.text).toMatch(/1100 of the 1232 bytes/);
    const two = sizeStatement({ ok: true, cross: 'x', transactions: 7, sizes: { createAndRules: 1000, withPrefix: 1300, firstTransactions: 2 } });
    expect(two.tone).toBe('warn');
    expect(two.text).toMatch(/1300 bytes, over the 1232/);
    expect(two.text).toMatch(/sent as two/);
    expect(TRANSACTION_LIMIT).toBe(1232);
  });

  it('reads TX_TOO_LARGE and any other refusal of the API as what it is', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'The creation and the rules are 1300 bytes.', reason: 'TX_TOO_LARGE', bytes: 1300 }), { status: 422 })) as typeof fetch;
      expect(await measureCreation({})).toMatchObject({ ok: false, reason: 'TX_TOO_LARGE', bytes: 1300 });
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'no' }), { status: 400 })) as typeof fetch;
      expect(await measureCreation({})).toMatchObject({ ok: false, reason: 'OTHER', error: 'no' });
      globalThis.fetch = (async () => {
        throw new Error('offline');
      }) as typeof fetch;
      expect(await measureCreation({})).toMatchObject({ ok: false, reason: 'OTHER', error: expect.stringMatching(/could not be reached/) });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the rules in a saved draft', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  it('survive a round trip and do not leak between drafts', () => {
    const d = { ...newDraft(now), rules: form({ endingMins: '30', insiders: [WALLET], drawnEnd: true }) };
    const back = parseDraft(serializeDraft(d), newDraft(now))!;
    expect(back.rules).toEqual(d.rules);
    back.rules.insiders.push('x');
    expect(newDraft(now).rules.insiders).toEqual([]);
  });
  it('come back empty field by field from a draft written before the rules step, or with a wrong type', () => {
    const old = JSON.parse(serializeDraft(newDraft(now))) as Record<string, unknown>;
    delete old.rules;
    expect(parseDraft(JSON.stringify(old), newDraft(now))!.rules).toEqual(EMPTY_RULES_FORM);
    old.rules = { endingMins: 5, buckets: '4', drawnEnd: 'yes', insiders: [1, 2], extraFeeds: ['a'] };
    expect(parseDraft(JSON.stringify(old), newDraft(now))!.rules).toEqual({ ...EMPTY_RULES_FORM, buckets: '4', extraFeeds: ['a'] });
  });
});
