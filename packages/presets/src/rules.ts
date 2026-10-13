// The rules step of the issuer wizard, as data: the form every cross_core rule is typed into, the limits the program enforces, and
// presets that fill the form with a starting shape.
//
// The form holds what a person types (strings for numbers, in human units: minutes, days, percent, whole tokens). Turning it into the
// `rules` object of POST /v1/tx/create-cross-ruled needs the two mints' decimals, so that lives with the web app (`issuer-rules.ts`);
// this file has no dependency on it. Whether a rule set is acceptable is decided by the SDK's `checkRules`, which the API runs on
// POST /v1/rules/check and on creation; nothing here re-implements it, and the limits below are only the ones the form needs to size its
// own lists (a test compares them with the program's constants).
//
// A preset never chooses an amount that belongs to the token being issued (a cap in quote tokens, a bond, a price). It sets structure
// and conventions of this product, all editable, and names what the issuer must still supply.

/** Limits of the rules extension, as the SDK exports them (`MAX_BUCKETS`, `MAX_INSIDERS`, `MAX_REFERRAL_BPS`, `rules-check.ts`). */
export const RULE_LIMITS = {
  maxBuckets: 8,
  maxInsiders: 8,
  maxExtraFeeds: 2,
  maxReferralBps: 5_000,
  maxLockSecs: 4 * 365 * 24 * 60 * 60,
  minChallengeSecs: 3_600,
  maxChallengeSecs: 30 * 24 * 3_600,
  maxExtensionSecs: 7 * 24 * 60 * 60,
  maxMoveBps: 50_000,
  maxWidenBps: 5_000,
} as const;

export type RulesForm = {
  // ending
  /** Length of the ending period before close, in minutes. Empty = no ending period. */
  endingMins: string;
  buckets: string;
  drawnEnd: boolean;
  cancelCutoffMins: string;
  /** One drawn extension if the cross fails its guards: the shortest and longest it may be, in minutes. Empty = none. */
  extensionMinMins: string;
  extensionMaxMins: string;
  // guards
  minRaise: string;
  maxDelivered: string;
  declaredSupply: string;
  minFloatPct: string;
  /** The largest allowed ratio of fully diluted value to the amount raised, e.g. "20" for 20 to 1. */
  maxFdvRatio: string;
  movePct: string;
  anchorPrice: string;
  standardGrid: boolean;
  gridEstimate: string;
  // stocks and halts
  guardScaledUi: boolean;
  resumesHalt: boolean;
  haltSource: string;
  feedsLenders: boolean;
  calendar: string;
  // identity
  identityCap: string;
  identityMaxOrders: string;
  // allocation
  reserveSmallPct: string;
  reserveLockedPct: string;
  reservePriorityPct: string;
  smallCap: string;
  lotteryLot: string;
  minLockDays: string;
  lockVestDays: string;
  /** `YYYY-MM-DDTHH:mm` local time of the early-commitment deadline. Empty = none. */
  earlyUntil: string;
  priorityGate: string;
  class1CliffDays: string;
  class1VestDays: string;
  // neutrality
  insiders: string[];
  insiderCliffDays: string;
  insiderVestDays: string;
  bond: string;
  challengeDays: string;
  // oracle set
  extraFeeds: string[];
  quorum: string;
  maxSpreadPct: string;
  offHoursWidenPct: string;
  // referral
  referrer: string;
  referralSharePct: string;
};

export const EMPTY_RULES_FORM: RulesForm = {
  endingMins: '',
  buckets: '',
  drawnEnd: false,
  cancelCutoffMins: '',
  extensionMinMins: '',
  extensionMaxMins: '',
  minRaise: '',
  maxDelivered: '',
  declaredSupply: '',
  minFloatPct: '',
  maxFdvRatio: '',
  movePct: '',
  anchorPrice: '',
  standardGrid: false,
  gridEstimate: '',
  guardScaledUi: false,
  resumesHalt: false,
  haltSource: '',
  feedsLenders: false,
  calendar: '',
  identityCap: '',
  identityMaxOrders: '',
  reserveSmallPct: '',
  reserveLockedPct: '',
  reservePriorityPct: '',
  smallCap: '',
  lotteryLot: '',
  minLockDays: '',
  lockVestDays: '',
  earlyUntil: '',
  priorityGate: '',
  class1CliffDays: '',
  class1VestDays: '',
  insiders: [],
  insiderCliffDays: '',
  insiderVestDays: '',
  bond: '',
  challengeDays: '',
  extraFeeds: [],
  quorum: '',
  maxSpreadPct: '',
  offHoursWidenPct: '',
  referrer: '',
  referralSharePct: '',
};

/** The form with a copy of every list, so a stored or preset form is never shared between drafts. */
export const cloneRulesForm = (f: RulesForm): RulesForm => ({ ...f, insiders: [...f.insiders], extraFeeds: [...f.extraFeeds] });

/** True when nothing is set: the cross is created exactly as it would be without the rules extension. */
export function rulesFormIsEmpty(f: RulesForm): boolean {
  return (Object.keys(EMPTY_RULES_FORM) as (keyof RulesForm)[]).every((k) => {
    const v = f[k];
    return Array.isArray(v) ? v.every((x) => x.trim() === '') : typeof v === 'string' ? v.trim() === '' : v === false;
  });
}

/** What a preset leaves for the issuer to supply, in the form's own field names. */
export type RulePreset = {
  id: string;
  name: string;
  summary: string;
  /** Other parts of the cross the preset relies on; the rules step says so beside it. */
  needs: ('gate' | 'mint' | 'oracle' | 'calendar')[];
  /** Fields the preset deliberately leaves empty because only the issuer can fill them. */
  yoursToFill: (keyof RulesForm)[];
  patch: Partial<RulesForm>;
};

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    id: 'none',
    name: 'No extra rules',
    summary: 'The cross is created as it is today, with no rules tail. Every rule below is off.',
    needs: [],
    yoursToFill: [],
    patch: {},
  },
  {
    id: 'hard-to-game-ending',
    name: 'Hard-to-game ending',
    summary: 'The last 30 minutes are cut into 6 buckets, cancels close 30 minutes before that, and the cluster draws which bucket is the last one counted. A bid placed at the last moment may be left out; an early bid loses nothing.',
    needs: [],
    yoursToFill: [],
    patch: { endingMins: '30', buckets: '6', drawnEnd: true, cancelCutoffMins: '30' },
  },
  {
    id: 'small-buyers-first',
    name: 'Verified small buyers first',
    summary: 'One application per verified identity, and a reserved share of the oversubscribed tick for small buyers. You set the largest order that counts as small.',
    needs: ['gate', 'mint'],
    yoursToFill: ['smallCap'],
    patch: { identityMaxOrders: '1', reserveSmallPct: '20' },
  },
  {
    id: 'anti-flip',
    name: 'Locked allocation',
    summary: 'A share of the oversubscribed tick is reserved for buyers who accept a lockup: 90 days to unlock, then 90 days of linear vesting. Buyers may choose a longer lock.',
    needs: ['mint'],
    yoursToFill: [],
    patch: { reserveLockedPct: '30', minLockDays: '90', lockVestDays: '90' },
  },
  {
    id: 'declared-insiders',
    name: 'Declared insiders with a bond',
    summary: 'Name the wallets that belong to the team. Their fills are locked (180 days to unlock, then a year of linear vesting) and left out of the minimum volume, the raise and the float. Anyone may challenge a wallet that was not declared for 7 days after the clear. You post the bond.',
    needs: ['mint'],
    yoursToFill: ['insiders', 'bond'],
    patch: { challengeDays: '7', insiderCliffDays: '180', insiderVestDays: '365' },
  },
  {
    id: 'stock-reopen',
    name: 'Tokenized stock reopen',
    summary: 'The standard grid (the first price at least half the published estimate, steps of at most one percent of it, the estimate inside the grid), a guard against a changed scaled-UI multiplier, and a 20 percent price-move bound against the estimate.',
    needs: ['calendar'],
    yoursToFill: ['gridEstimate'],
    patch: { standardGrid: true, guardScaledUi: true, movePct: '20' },
  },
  {
    id: 'oracle-median',
    name: 'Median of two oracles',
    summary: 'The cross prints only if two oracles agree: a second Pyth feed, a quorum of 2 and a limit on how far apart they may be. Needs the oracle guard switched on above; you supply the second feed.',
    needs: ['oracle'],
    yoursToFill: ['extraFeeds'],
    patch: { quorum: '2', maxSpreadPct: '2', extraFeeds: [''] },
  },
];

export const rulePreset = (id: string): RulePreset | undefined => RULE_PRESETS.find((p) => p.id === id);

/** A preset replaces the whole form (it never merges with what was typed, so what it sets is exactly what the preset says). */
export const applyRulePreset = (p: RulePreset): RulesForm => cloneRulesForm({ ...EMPTY_RULES_FORM, ...p.patch });
