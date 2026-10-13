import { describe, expect, it } from 'vitest';
import {
  type RulesCalls,
  type RulesJson,
  type Standing,
  type TicketInput,
  MAX_LOCK_SECS,
  blocked,
  cancelDeadlineOf,
  classOptions,
  summaryLines,
  endingNow,
  explainOutcome,
  imbalanceText,
  needsAck,
  ticketChecks,
} from '../src/lib/rules';

const M = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
const WALLET = '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT';
const INSIDER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const CLOSE = 2_000_000n;
const DAY = 86_400;

const off = (): RulesJson => ({
  flags: { resumesHalt: false, feedsLenders: false, standardGrid: false, guardScaledUi: false },
  guards: { minRaiseQuote: '0', maxMatched: '0', totalSupply: '0', minFloatBps: 0, maxFdvX100: 0, anchorPrice: '0', moveBps: 0, gridEstimate: '0', haltSource: null },
  ending: { endingSecs: 0, buckets: 0, cancelCutoffSecs: 0, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0 },
  identity: { capQuote: '0', maxOrders: 0 },
  alloc: { reserveBps: [0, 0, 0], smallCapQuote: '0', lotteryUnit: '0', minLockSecs: 0, lockVestSecs: 0, earlyUntilTs: '0', priorityGate: null, class1CliffSecs: 0, class1VestSecs: 0 },
  neutrality: { insiders: [], insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: '0', challengeSecs: 0 },
  referral: null,
  oracleSet: { extraFeeds: [], quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
});
const withRules = (over: Partial<RulesJson>): RulesJson => ({ ...off(), ...over });
const standing = (over: Partial<Standing> = {}): Standing => ({ gatePass: true, priorityPass: null, usage: { orders: 0, escrow: 0n }, ...over });
const calls = (over: Partial<RulesCalls> = {}): RulesCalls => ({ classBook: false, lockVault: false, needsDraw: false, drawOwed: null, drawStatus: 'not-begun', auxShards: [], cancelDeadline: String(CLOSE), endingStartsAt: null, ...over });

describe('endingNow', () => {
  const r = withRules({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 } });
  const start = CLOSE - 400n;
  it('is none without rules or without an ending period', () => {
    expect(endingNow(null, undefined, CLOSE, 0n)).toEqual({ kind: 'none' });
    expect(endingNow(off(), undefined, CLOSE, 0n)).toEqual({ kind: 'none' });
  });
  it('is before until the period starts, then names the window and when it ends, mirroring the program', () => {
    expect(endingNow(r, undefined, CLOSE, start - 1n)).toEqual({ kind: 'before', startsAt: start });
    expect(endingNow(r, undefined, CLOSE, start)).toMatchObject({ kind: 'ending', bucket: 0, buckets: 4, bucketEndsAt: start + 100n });
    expect(endingNow(r, undefined, CLOSE, start + 99n)).toMatchObject({ bucket: 0 });
    expect(endingNow(r, undefined, CLOSE, start + 100n)).toMatchObject({ bucket: 1, bucketEndsAt: start + 200n });
    expect(endingNow(r, undefined, CLOSE, CLOSE - 1n)).toMatchObject({ bucket: 3, bucketEndsAt: CLOSE });
  });
  it('rounds a window boundary up when the period does not divide evenly (ceil, as the API computes validUntil)', () => {
    const odd = withRules({ ending: { endingSecs: 10, buckets: 3, cancelCutoffSecs: 0, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0 } });
    const s = CLOSE - 10n;
    expect(endingNow(odd, undefined, CLOSE, s)).toMatchObject({ bucket: 0, bucketEndsAt: s + 4n });
    expect(endingNow(odd, undefined, CLOSE, s + 3n)).toMatchObject({ bucket: 0 });
    expect(endingNow(odd, undefined, CLOSE, s + 4n)).toMatchObject({ bucket: 1, bucketEndsAt: s + 7n });
  });
  it('is the extension once the call has been reopened', () => {
    expect(endingNow(r, { draw: { epoch: 1, seedReady: true, endBucket: null, extensionPending: false, extensionUsed: true, pendingSlot: null }, neutrality: { bondHeld: '0', slashed: '0', openChallenges: 0, challenges: 0 }, clearing: null, noPrintReason: null }, CLOSE, start + 5n)).toEqual({ kind: 'extension' });
  });
});

describe('cancelDeadlineOf', () => {
  it('is the close for a cross without rules and the rules’ deadline otherwise', () => {
    expect(cancelDeadlineOf(undefined, CLOSE)).toBe(CLOSE);
    expect(cancelDeadlineOf(calls({ cancelDeadline: '1999000' }), CLOSE)).toBe(1_999_000n);
  });
});

describe('classOptions', () => {
  const r = withRules({ alloc: { ...off().alloc, reserveBps: [3000, 2000, 1000], smallCapQuote: '5000000', lotteryUnit: '5000000', minLockSecs: 30 * DAY, earlyUntilTs: '1500000', priorityGate: INSIDER } });
  const c = { wallet: WALLET, now: 1_000_000n, market: M, gated: true };
  it('offers only the classes the cross reserves anything for, and always the general class', () => {
    expect(classOptions(off(), c, standing()).map((o) => o.id)).toEqual([0]);
    expect(classOptions(r, c, standing()).map((o) => o.id)).toEqual([0, 1, 2, 3]);
  });
  it('class 1 needs the gate pass; class 3 needs the early window or a priority pass, and says which is missing', () => {
    const noPass = classOptions(r, c, standing({ gatePass: false }));
    expect(noPass.find((o) => o.id === 1)).toMatchObject({ available: false, why: expect.stringMatching(/no pass for the cross’s gate/) });
    const late = classOptions(r, { ...c, now: 1_600_000n }, standing({ priorityPass: false }));
    expect(late.find((o) => o.id === 3)).toMatchObject({ available: false, why: expect.stringMatching(/early window closed.*no pass of the priority gate/) });
    expect(classOptions(r, { ...c, now: 1_600_000n }, standing({ priorityPass: true })).find((o) => o.id === 3)!.available).toBe(true);
    expect(classOptions(r, { ...c, now: 1_600_000n }, standing({ priorityPass: null })).find((o) => o.id === 3)!.available).toBe(true);
    expect(classOptions(r, c, standing({ priorityPass: false })).find((o) => o.id === 3)!.available).toBe(true);
  });
  it('class 1 is unavailable on a cross without a gate', () => {
    expect(classOptions(r, { ...c, gated: false }, standing()).find((o) => o.id === 1)).toMatchObject({ available: false, why: expect.stringMatching(/no eligibility gate/) });
  });
  it('a declared insider has the general class only, with the reason', () => {
    const ins = classOptions(withRules({ ...r, neutrality: { ...off().neutrality, insiders: [WALLET] } }), c, standing());
    expect(ins).toHaveLength(1);
    expect(ins[0]!.summary).toMatch(/declared insider/);
  });
});

describe('ticketChecks', () => {
  const base = (over: Partial<TicketInput> = {}): TicketInput => ({
    rules: withRules({ alloc: { ...off().alloc, reserveBps: [3000, 2000, 1000], smallCapQuote: '5000000', lotteryUnit: '0', minLockSecs: 30 * DAY, earlyUntilTs: '0', priorityGate: INSIDER } }),
    wallet: WALLET,
    side: 'buy',
    cls: 0,
    lockSecs: 0,
    escrow: 3_000_000n,
    quantity: 2_000_000n,
    now: 1_000_000n,
    closeTs: CLOSE,
    market: M,
    gated: true,
    standing: standing(),
    ...over,
  });
  const ids = (cs: ReturnType<typeof ticketChecks>, level?: string) => cs.filter((c) => !level || c.level === level).map((c) => c.id);

  it('lets a plain order through a rule set that has no cutoff', () => {
    expect(blocked(ticketChecks(base()))).toEqual([]);
  });
  it('blocks a class-1 order over the small-buyer cap, with both figures', () => {
    const cs = ticketChecks(base({ cls: 1, escrow: 6_000_000n }));
    expect(ids(cs, 'block')).toEqual(['c1-cap']);
    expect(cs[0]!.message).toMatch(/at most 5 quote.*locks 6 quote/);
    expect(blocked(ticketChecks(base({ cls: 1, escrow: 5_000_000n })))).toEqual([]);
  });
  it('blocks a class-1 order that is not exactly one lot when the class is a lottery', () => {
    const r = withRules({ alloc: { ...off().alloc, reserveBps: [3000, 0, 0], smallCapQuote: '5000000', lotteryUnit: '2000000' } });
    expect(ids(ticketChecks(base({ rules: r, cls: 1, quantity: 1_000_000n })), 'block')).toEqual(['c1-lot']);
    const ok = ticketChecks(base({ rules: r, cls: 1, quantity: 2_000_000n }));
    expect(blocked(ok)).toEqual([]);
    expect(ids(ok, 'note')).toContain('c1-lottery');
  });
  it('blocks class 1 without a gate pass', () => {
    expect(ids(ticketChecks(base({ cls: 1, standing: standing({ gatePass: false }) })), 'block')).toEqual(['c1-pass']);
  });
  it('blocks a lockup that is too short or too long, and explains an acceptable one', () => {
    expect(ids(ticketChecks(base({ cls: 2, lockSecs: 0 })), 'block')).toEqual(['c2-short']);
    expect(ticketChecks(base({ cls: 2, lockSecs: 29 * DAY })).find((c) => c.id === 'c2-short')!.message).toMatch(/at least 30 days; 29 days is too short/);
    expect(ids(ticketChecks(base({ cls: 2, lockSecs: MAX_LOCK_SECS + 1 })), 'block')).toEqual(['c2-long']);
    const ok = ticketChecks(base({ cls: 2, lockSecs: 60 * DAY }));
    expect(blocked(ok)).toEqual([]);
    expect(ok.find((c) => c.id === 'c2-lock')!.message).toMatch(/locked for 60 days/);
  });
  it('blocks class 3 once the early window is over without a priority pass, and allows it with one', () => {
    const r = withRules({ alloc: { ...off().alloc, reserveBps: [0, 0, 1000], earlyUntilTs: '900000', priorityGate: INSIDER } });
    expect(ids(ticketChecks(base({ rules: r, cls: 3, standing: standing({ priorityPass: false }) })), 'block')).toEqual(['c3-ineligible']);
    expect(blocked(ticketChecks(base({ rules: r, cls: 3, standing: standing({ priorityPass: true }) })))).toEqual([]);
    expect(blocked(ticketChecks(base({ rules: r, cls: 3, now: 800_000n, standing: standing({ priorityPass: false }) })))).toEqual([]);
  });
  it('blocks a lockup on a class that is not the locked class', () => {
    expect(ids(ticketChecks(base({ cls: 0, lockSecs: 5 })), 'block')).toEqual(['c0-lock']);
  });
  it('ignores class and lockup on a sell', () => {
    expect(blocked(ticketChecks(base({ side: 'sell', cls: 1, lockSecs: 5 })))).toEqual([]);
  });
  it('applies the per-identity limits from the wallet’s live orders', () => {
    const r = withRules({ identity: { capQuote: '10000000', maxOrders: 2 } });
    expect(blocked(ticketChecks(base({ rules: r })))).toEqual([]);
    expect(ids(ticketChecks(base({ rules: r, standing: standing({ usage: { orders: 2, escrow: 1n } }) })), 'block')).toEqual(['limit-orders']);
    const over = ticketChecks(base({ rules: r, escrow: 4_000_000n, standing: standing({ usage: { orders: 1, escrow: 7_000_000n } }) }));
    expect(ids(over, 'block')).toEqual(['limit-escrow']);
    expect(over[0]!.message).toMatch(/at 10 quote.*7 quote escrowed.*adds 4 quote.*room for 3 quote/s);
    expect(ids(ticketChecks(base({ rules: r, standing: standing({ usage: null }) })), 'note')).toContain('limit-unread');
  });
  it('does not apply the limits to a sell’s escrow, and not to a declared insider', () => {
    const r = withRules({ identity: { capQuote: '10000000', maxOrders: 0 } });
    expect(blocked(ticketChecks(base({ rules: r, side: 'sell', standing: standing({ usage: { orders: 0, escrow: 9_000_000n } }) })))).toEqual([]);
  });
  it('a declared insider cannot take a class, and is told about its lock', () => {
    const r = withRules({ neutrality: { ...off().neutrality, insiders: [WALLET], insiderCliffSecs: 7 * DAY, insiderVestSecs: 90 * DAY }, alloc: off().alloc });
    const cs = ticketChecks(base({ rules: r, cls: 1 }));
    expect(ids(cs)).toEqual(expect.arrayContaining(['insider', 'insider-class']));
    expect(ids(cs, 'block')).toEqual(['insider-class']);
    expect(cs.find((c) => c.id === 'insider')!.message).toMatch(/locked for 7 days and then vests over 90 days/);
  });
  it('asks for acknowledgement once cancellation has closed, with the exact time, and only then', () => {
    const r = withRules({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 } });
    const deadline = CLOSE - 460n;
    const before = ticketChecks(base({ rules: r, calls: calls({ cancelDeadline: String(deadline) }), now: deadline - 100n }));
    expect(needsAck(before)).toEqual([]);
    expect(ids(before, 'note')).toContain('cutoff');
    const after = ticketChecks(base({ rules: r, calls: calls({ cancelDeadline: String(deadline) }), now: deadline + 1n }));
    expect(needsAck(after).map((c) => c.id)).toEqual(['cutoff-passed']);
    expect(needsAck(after)[0]!.message).toMatch(/Cancellation closed at 1970-01-.* it stays until the cross settles.*or its ending window is not counted/s);
  });
  it('names the ending window an order would land in', () => {
    const r = withRules({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 0, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 } });
    const cs = ticketChecks(base({ rules: r, calls: calls({ cancelDeadline: String(CLOSE - 400n) }), now: CLOSE - 150n }));
    expect(cs.find((c) => c.id === 'window')!.message).toMatch(/window 3 of 4.*ends in 50 seconds.*later window is refunded/s);
  });
  it('an order in the extension cannot be cancelled and must be acknowledged', () => {
    const r = withRules({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 0, randomEnd: true, extensionMinSecs: 60, extensionMaxSecs: 600 } });
    const state = { draw: { epoch: 1, seedReady: true, endBucket: null, extensionPending: false, extensionUsed: true, pendingSlot: null }, neutrality: { bondHeld: '0', slashed: '0', openChallenges: 0, challenges: 0 }, clearing: null, noPrintReason: null };
    expect(needsAck(ticketChecks(base({ rules: r, state, now: CLOSE - 10n }))).map((c) => c.id)).toEqual(['extension']);
  });
});

describe('explainOutcome', () => {
  it('says a cross that did not print refunded everyone', () => {
    expect(explainOutcome({ side: 'buy', escrow: 10n, fill: 0n, quoteOut: 10n, baseOut: 0n, crossPrinted: false }, M)).toEqual({ headline: 'Refunded in full', lines: [expect.stringMatching(/did not print/)] });
  });
  it('does not invent the reason an unfilled buy lost', () => {
    const o = explainOutcome({ side: 'buy', escrow: 5_000_000n, fill: 0n, quoteOut: 5_000_000n, baseOut: 0n, crossPrinted: true }, M);
    expect(o.headline).toBe('Not filled, refunded in full');
    expect(o.lines.join(' ')).toMatch(/5 quote escrow came back whole/);
    expect(o.lines.join(' ')).toMatch(/The index does not record which/);
  });
  it('reports a partial fill, the pro rata share and a reached hard cap', () => {
    const o = explainOutcome({ side: 'buy', escrow: 10_000_000n, fill: 4_000_000n, quoteOut: 6_000_000n, baseOut: 4_000_000n, crossPrinted: true, rationed: 'buy', maxMatched: 100_000_000n, matched: 100_000_000n }, M);
    expect(o.headline).toBe('Partly filled');
    expect(o.lines.join(' ')).toMatch(/Filled 4 tokens; the unused 6 quote of your escrow came back/);
    expect(o.lines.join(' ')).toMatch(/filled pro rata/);
    expect(o.lines.join(' ')).toMatch(/hard cap of 100 tokens was reached/);
  });
  it('reports a full fill and a sell', () => {
    expect(explainOutcome({ side: 'buy', escrow: 3n, fill: 3n, quoteOut: 0n, baseOut: 3n, crossPrinted: true }, M).headline).toBe('Filled');
    expect(explainOutcome({ side: 'sell', escrow: 10_000_000n, fill: 4_000_000n, quoteOut: 1n, baseOut: 6_000_000n, crossPrinted: true }, M).lines[0]).toMatch(/Sold 4 tokens; the unsold 6 tokens came back/);
  });
});

describe('imbalanceText', () => {
  it('words the three directions the API serves', () => {
    expect(imbalanceText('balanced')).toBe('About balanced');
    expect(imbalanceText('demand-heavy')).toBe('More wanted than offered');
    expect(imbalanceText('supply-heavy')).toBe('More offered than wanted');
  });
});

describe('summaryLines', () => {
  it('says a record with every rule off is a plain call auction', () => {
    expect(summaryLines(off(), M, CLOSE)).toEqual(['Every rule in this record is off: it behaves as a plain call auction.']);
  });
  it('states the ending period, the cutoff, the guards, the limits and the classes briefly', () => {
    const r = withRules({
      ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 },
      guards: { ...off().guards, minRaiseQuote: '5000000000', maxMatched: '1000000000' },
      identity: { capQuote: '100000000', maxOrders: 1 },
      alloc: { ...off().alloc, reserveBps: [3000, 0, 1000], smallCapQuote: '5000000', minLockSecs: 30 * DAY },
    });
    const text = summaryLines(r, M, CLOSE).join('\n');
    expect(text).toMatch(/last 6 minutes 40 seconds is an ending period of 4 windows/);
    expect(text).toMatch(/cancelled until 1970-01-/);
    expect(text).toMatch(/raise of 5,?000 quote/);
    expect(text).toMatch(/At most 1,?000 tokens are sold/);
    expect(text).toMatch(/Per wallet: 1 live order, 100 quote escrowed at most/);
    expect(text).toMatch(/Class 1.*5 quote/);
    expect(text).toMatch(/Class 2.*30 days/);
  });
});
