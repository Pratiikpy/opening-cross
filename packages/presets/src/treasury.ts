// The treasury extension's terms as a form, and the presets an issuer can start from.
//
// `init_ext` fixes these terms for good: after it, the program enforces them and nothing can change them (ADR-0470 to ADR-0476). The form holds
// what a person types, in the units a person thinks in (days, percent, hours, whole quote tokens); turning it into the request needs the quote
// token's decimals and lives in the web app. Whether the terms are acceptable is decided by `checkExtParams` in `@opening-cross/treasury-client`,
// which the API runs; nothing here re-implements it. A test compares `FLAGSHIP_FACTS` with `flagshipExtParams`.

export const TERMS_INSIDER_SLOTS = 4;

export type TermsForm = {
  // holder votes
  votePeriodDays: string;
  timelockDays: string;
  quorumPct: string;
  thresholdPct: string;
  maxProposalPct: string;
  proposerMinPct: string;
  // NAV redemption wall
  navPeriodDays: string;
  navCapPct: string;
  insiders: string[];
  // distributions
  streamHours: string;
  // revenue rounds
  revSharePct: string;
  revCredential: string;
  revSchema: string;
  roundDays: string;
  /** `YYYY-MM-DDTHH:mm` local time the first round starts. */
  revStart: string;
  payGraceDays: string;
  trancheMinRevenue: string;
  trancheAmount: string;
  // team grants
  minLockupDays: string;
  // disclosure
  disclosurePeriodDays: string;
  requestMinPct: string;
  // assignment
  assignRequired: boolean;
  assignCredential: string;
  assignSchema: string;
  // wind-down
  windowDays: string;
  recovery: string;
};

export const EMPTY_TERMS: TermsForm = {
  votePeriodDays: '',
  timelockDays: '',
  quorumPct: '',
  thresholdPct: '',
  maxProposalPct: '',
  proposerMinPct: '',
  navPeriodDays: '',
  navCapPct: '',
  insiders: [],
  streamHours: '',
  revSharePct: '',
  revCredential: '',
  revSchema: '',
  roundDays: '',
  revStart: '',
  payGraceDays: '',
  trancheMinRevenue: '',
  trancheAmount: '',
  minLockupDays: '',
  disclosurePeriodDays: '',
  requestMinPct: '',
  assignRequired: false,
  assignCredential: '',
  assignSchema: '',
  windowDays: '',
  recovery: '',
};

export const cloneTerms = (t: TermsForm): TermsForm => ({ ...t, insiders: [...t.insiders] });

export type TermsPreset = {
  id: string;
  name: string;
  summary: string;
  /** `flagship` is built by the API from its own preset (the values below are shown, not sent); `custom` sends every term. */
  kind: 'flagship' | 'custom';
  patch: Partial<TermsForm>;
  /** Terms the preset leaves for the issuer, by form key. */
  yoursToFill: (keyof TermsForm)[];
};

/** The terms of the API's flagship preset, as the form shows them. A test holds this equal to `flagshipExtParams`. */
export const FLAGSHIP_FACTS = {
  votePeriodDays: 7,
  timelockDays: 2,
  quorumPct: 20,
  thresholdPct: 50,
  maxProposalPct: 20,
  proposerMinPct: 1,
  minLockupDays: 365,
  navPeriodDays: 30,
  navCapPct: 10,
  streamDays: 7,
  roundDays: 30,
  payGraceDays: 14,
  disclosurePeriodDays: 35,
  requestMinPct: 1,
  windowDays: 365,
} as const;

export const TERMS_PRESETS: readonly TermsPreset[] = [
  {
    id: 'flagship',
    name: 'Flagship offering',
    summary:
      'The full set a real-company offering would start from: a 7-day vote with a 2-day timelock and a 20% quorum, a NAV window each 30 days capped at 10% of the supply, a 365-day lockup on team grants, monthly revenue rounds with a 14-day grace, a disclosure deadline of 35 days, an assignment gate and a 365-day wind-down. A proposal for counsel to review, not legal advice.',
    kind: 'flagship',
    patch: {},
    yoursToFill: ['revSharePct', 'revCredential', 'revSchema', 'revStart', 'assignCredential', 'assignSchema', 'recovery'],
  },
  {
    id: 'governed',
    name: 'Votes, NAV and disclosure',
    summary: 'Holders vote on spending above the allowance (7 days, 2-day timelock, 20% quorum), may vote open a NAV window (30 days, 10% of supply), the team’s grants lock for 365 days, a disclosure is due every 35 days, and the vault can be wound down over 365 days.',
    kind: 'custom',
    patch: {
      votePeriodDays: '7',
      timelockDays: '2',
      quorumPct: '20',
      thresholdPct: '50',
      maxProposalPct: '20',
      proposerMinPct: '1',
      navPeriodDays: '30',
      navCapPct: '10',
      minLockupDays: '365',
      disclosurePeriodDays: '35',
      requestMinPct: '1',
      windowDays: '365',
    },
    yoursToFill: ['recovery'],
  },
  {
    id: 'distributions',
    name: 'Distributions to stakers',
    summary: 'Only distributions: anyone may add quote tokens for holders who stake their coins, streamed to them over 7 days. No votes, no NAV window, no revenue rounds.',
    kind: 'custom',
    patch: { streamHours: '168' },
    yoursToFill: [],
  },
];

export const termsPreset = (id: string): TermsPreset | undefined => TERMS_PRESETS.find((p) => p.id === id);
export const applyTermsPreset = (p: TermsPreset): TermsForm => cloneTerms({ ...EMPTY_TERMS, ...p.patch });
