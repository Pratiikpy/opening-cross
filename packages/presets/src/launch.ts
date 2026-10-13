// Launch presets and listing types for the issuer wizard.
//
// A preset is a starting shape: the format of the cross, how many price levels it has and how long the call runs. It never
// chooses a price, a supply or a raise target, because those belong to the token being issued, and it is not advice about what
// a good raise looks like. Every field it sets stays editable.
//
// A listing type is what the issuer is bringing to market. It names the cross kind and preset that fit it, which optional modules
// (a treasury, a gate, an oracle guard) the type usually wants, and, for the types that need a licensed partner, exactly what is
// missing and which human task (docs/HUMAN_TASKS.md) unblocks it. Nothing here is legal advice: whether an offering may be made
// to a given buyer is a question for counsel (H2).
//
// All values below are protocol facts the programs enforce or conventions of this product. There are no market figures.

export type CrossKind = 'launch' | 'reopen' | 'tender' | 'recurring';
export type Disclosure = 'sealed' | 'open';
export type SupplyMode = 'escrow' | 'mint';

/** The form fields a preset sets. */
export type LaunchPresetFields = {
  kind: CrossKind;
  disclosure: Disclosure;
  supplyMode: SupplyMode;
  /** Number of price levels (the program allows 2 to 256 for this form). */
  ticks: number;
  /** The step between prices as a share of the lowest price, in basis points; applied only where it lands exactly on a quote atom. */
  stepBps: number;
  /** Minutes from now until orders open. */
  openInMinutes: number;
  /** Minutes the call stays open. */
  callMinutes: number;
  /** Minutes allowed for revealing a sealed bid (used only for sealed crosses). */
  revealMinutes: number;
  maxOrders: number;
};

/** Optional modules a preset points the issuer to. They are suggestions the wizard lists as steps; none is switched on silently. */
export type ModuleAdvice = {
  /** Whether an ownership-coin treasury fits this shape. It can only be created once the coin has a fixed supply. */
  treasury: 'recommended' | 'optional' | 'not-applicable';
  /** Whether an identity gate is worth considering. Which rules an offering needs is a legal question. */
  gate: 'consider' | 'optional';
  /** Whether the oracle divergence guard fits (a token that already has a reference price elsewhere). */
  oracleGuard: 'recommended' | 'optional' | 'not-applicable';
};

export type LaunchPreset = {
  id: string;
  name: string;
  summary: string;
  fields: LaunchPresetFields;
  modules: ModuleAdvice;
};

export const LAUNCH_PRESETS: readonly LaunchPreset[] = [
  {
    id: 'sealed-launch',
    name: 'Sealed launch',
    summary: 'A new token minted at settlement. Sealed bids, a 24 hour call and a 30 minute reveal.',
    fields: { kind: 'launch', disclosure: 'sealed', supplyMode: 'mint', ticks: 40, stepBps: 500, openInMinutes: 60, callMinutes: 24 * 60, revealMinutes: 30, maxOrders: 1000 },
    modules: { treasury: 'recommended', gate: 'optional', oracleGuard: 'not-applicable' },
  },
  {
    id: 'open-launch',
    name: 'Open-book launch',
    summary: 'A new token minted at settlement. Everyone sees the book as orders arrive; a 6 hour call.',
    fields: { kind: 'launch', disclosure: 'open', supplyMode: 'mint', ticks: 40, stepBps: 500, openInMinutes: 60, callMinutes: 6 * 60, revealMinutes: 30, maxOrders: 1000 },
    modules: { treasury: 'recommended', gate: 'optional', oracleGuard: 'not-applicable' },
  },
  {
    id: 'reopen',
    name: 'Reopening auction',
    summary: 'A token that already trades, sold from escrow through an open book over 4 hours.',
    fields: { kind: 'reopen', disclosure: 'open', supplyMode: 'escrow', ticks: 60, stepBps: 100, openInMinutes: 60, callMinutes: 4 * 60, revealMinutes: 30, maxOrders: 1000 },
    modules: { treasury: 'not-applicable', gate: 'consider', oracleGuard: 'recommended' },
  },
  {
    id: 'tender',
    name: 'Sealed tender',
    summary: 'Holders offer tokens from escrow to a sealed call over 48 hours.',
    fields: { kind: 'tender', disclosure: 'sealed', supplyMode: 'escrow', ticks: 60, stepBps: 100, openInMinutes: 60, callMinutes: 48 * 60, revealMinutes: 60, maxOrders: 1000 },
    modules: { treasury: 'not-applicable', gate: 'consider', oracleGuard: 'optional' },
  },
  {
    id: 'recurring',
    name: 'Daily recurring call',
    summary: 'A short open-book call for a token with a standing supply schedule, 2 hours long.',
    fields: { kind: 'recurring', disclosure: 'open', supplyMode: 'mint', ticks: 40, stepBps: 200, openInMinutes: 60, callMinutes: 120, revealMinutes: 30, maxOrders: 1000 },
    modules: { treasury: 'optional', gate: 'optional', oracleGuard: 'optional' },
  },
];

export const launchPreset = (id: string): LaunchPreset | undefined => LAUNCH_PRESETS.find((p) => p.id === id);

/**
 * The step between prices for a preset: `stepBps` of the lowest price, in quote atoms, when that division is exact; otherwise
 * null, and the form keeps the step it has. A step that did not divide exactly would put the grid off the quote token's atoms.
 */
export function stepAtoms(minPriceAtoms: bigint, stepBps: number): bigint | null {
  if (minPriceAtoms <= 0n || !Number.isInteger(stepBps) || stepBps <= 0) return null;
  const scaled = minPriceAtoms * BigInt(stepBps);
  return scaled % 10_000n === 0n ? scaled / 10_000n : null;
}

// ---------------------------------------------------------------------------------------------------------------- listing types

export type ListingTypeId = 'ownership-coin' | 'revenue-share' | 'existing-token' | 'tender' | 'recurring' | 'tokenized-stock' | 'pre-ipo' | 'rwa-yield';

export type ListingType = {
  id: ListingTypeId;
  name: string;
  summary: string;
  /** `available` can be created from the wizard today. `needs-partner` cannot, and `blocker` says why. */
  availability: 'available' | 'needs-partner';
  /** The preset the wizard applies for this type; null where the type cannot be created yet. */
  presetId: string | null;
  /** What the issuer gets in the way of holder rights, in the terms the treasury program enforces; null for none. */
  rights: string | null;
  /** For `needs-partner` types: what is missing, in one sentence. */
  blocker: string | null;
  /** The docs/HUMAN_TASKS.md entries that unblock it. */
  humanTasks: readonly string[];
  /** Whether the checker for "is this mint already a listed tokenizer's stock token" matters for this type. */
  stockTokenCheck: boolean;
};

export const LISTING_TYPES: readonly ListingType[] = [
  {
    id: 'ownership-coin',
    name: 'Ownership coin',
    summary: 'A new coin for a company or project, minted by the cross at the clearing price, with an optional program-held treasury.',
    availability: 'available',
    presetId: 'sealed-launch',
    rights: 'With a treasury: a spend allowance per period, release only while an attestation from the attester you name is live, and pro-rata redemption if it lapses.',
    blocker: null,
    humanTasks: [],
    stockTokenCheck: false,
  },
  {
    id: 'revenue-share',
    name: 'Revenue-share token',
    summary: 'A coin whose treasury only releases funds while an attestation from the attester you name is live. Payouts to holders are not automated yet.',
    availability: 'available',
    presetId: 'open-launch',
    rights: 'The same treasury rules as an ownership coin. The program does not pay revenue out to holders; that needs a distribution program that does not exist yet. What the attestation says (for example, verified revenue) is between you and your attester.',
    blocker: null,
    humanTasks: ['HT3'],
    stockTokenCheck: false,
  },
  {
    id: 'existing-token',
    name: 'Existing token, reopening',
    summary: 'A token that already exists and trades, sold from escrow through an open book.',
    availability: 'available',
    presetId: 'reopen',
    rights: null,
    blocker: null,
    humanTasks: [],
    stockTokenCheck: true,
  },
  {
    id: 'tender',
    name: 'Tender',
    summary: 'Holders offer tokens from escrow into a sealed call. Whether an offering like this is permitted is for counsel.',
    availability: 'available',
    presetId: 'tender',
    rights: null,
    blocker: null,
    humanTasks: ['H2', 'HS4'],
    stockTokenCheck: false,
  },
  {
    id: 'recurring',
    name: 'Recurring call',
    summary: 'A short call that repeats for a token with a standing supply schedule. There is no scheduler: each call is created by hand.',
    availability: 'available',
    presetId: 'recurring',
    rights: null,
    blocker: null,
    humanTasks: [],
    stockTokenCheck: false,
  },
  {
    id: 'tokenized-stock',
    name: 'Tokenized stock or ETF',
    summary: 'A newly tokenized stock listed through a licensed tokenizer. A stock token a tokenizer has already issued can run a reopening auction today.',
    availability: 'needs-partner',
    presetId: null,
    rights: null,
    blocker: 'Issuing a stock token needs a licensed tokenizer and counsel. This product holds no such licence and has no tokenizer integration.',
    humanTasks: ['H2', 'HG4'],
    stockTokenCheck: true,
  },
  {
    id: 'pre-ipo',
    name: 'Pre-IPO exposure',
    summary: 'Economic exposure to a company that has not listed.',
    availability: 'needs-partner',
    presetId: null,
    rights: null,
    blocker: 'Needs an entity or SPV structure, a placement partner and counsel. None exists for this product yet.',
    humanTasks: ['H1', 'H2', 'HT2'],
    stockTokenCheck: false,
  },
  {
    id: 'rwa-yield',
    name: 'Real-world-asset yield',
    summary: 'A token backed by an off-chain asset that pays yield.',
    availability: 'needs-partner',
    presetId: null,
    rights: null,
    blocker: 'Needs asset verification (custodian or proof-of-reserve), a legal structure and counsel. No verifier is integrated.',
    humanTasks: ['H2', 'HG3', 'HG4'],
    stockTokenCheck: false,
  },
];

export const listingType = (id: string): ListingType | undefined => LISTING_TYPES.find((t) => t.id === id);

// ---------------------------------------------------------------------------------------------------------------- auto-fill

/** What the chain says about a token the issuer entered. */
export type TokenFacts = {
  decimals: number;
  /** Token-2022 or the classic token program. */
  program: 'token' | 'token-2022' | 'other';
  /** Current total supply in base atoms. */
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: readonly string[];
  /** The Token-2022 metadata extension, when present. */
  metadata: { name: string; symbol: string } | null;
};

export type AutofillField = 'supplyMode' | 'presetId' | 'listingType';

/** One suggestion, with the chain fact behind it. A suggestion is applied only when the issuer accepts it. */
export type Suggestion = {
  field: AutofillField;
  value: string;
  /** The fact on chain that led to it, in plain words. */
  because: string;
};

export type Autofill = {
  /** What was read from the token, as short statements the form can list. */
  facts: string[];
  suggestions: Suggestion[];
  /** Things that stop a cross with this token, in plain words. Empty when nothing stops it. */
  blockers: string[];
  /** Things worth knowing that do not stop a cross. */
  notes: string[];
};

const BLOCKING_EXTENSIONS: Record<string, string> = {
  transferHook: 'it has a transfer hook, which a cross cannot settle through',
  transferFeeConfig: 'it charges a transfer fee, so amounts would not match what was escrowed',
  nonTransferable: 'it is non-transferable',
};

/**
 * What a token implies for the wizard. It reads only the facts it is given and never produces a number the issuer must choose
 * (price, supply, raise target): it can say which supply mode the token's authorities allow and why.
 */
export function autofillFromToken(t: TokenFacts, wallet: string | null): Autofill {
  const facts: string[] = [`${t.decimals} decimals`, t.program === 'token-2022' ? 'Token-2022 program' : t.program === 'token' ? 'classic token program' : 'unrecognised token program'];
  if (t.metadata) facts.push(`named ${t.metadata.name} (${t.metadata.symbol}) in its own metadata`);
  facts.push(t.mintAuthority === null ? 'mint authority revoked: the supply is fixed' : wallet === null ? 'a mint authority is set' : t.mintAuthority === wallet ? 'your wallet holds the mint authority' : 'another address holds the mint authority');
  if (t.freezeAuthority !== null) facts.push('a freeze authority is set');
  facts.push(t.supply === 0n ? 'no supply minted yet' : 'supply already minted');

  const blockers: string[] = [];
  const notes: string[] = [];
  const suggestions: Suggestion[] = [];

  for (const e of t.extensions) {
    const why = BLOCKING_EXTENSIONS[e];
    if (why) blockers.push(`This token cannot be used: ${why}.`);
  }
  if (t.freezeAuthority !== null) notes.push('The freeze authority can freeze any holder of this token. Buyers will see this on the cross page.');
  if (t.extensions.includes('permanentDelegate')) notes.push('A permanent delegate can move or burn any holder’s tokens. Buyers will see this on the cross page.');

  if (wallet !== null && t.mintAuthority === wallet) {
    suggestions.push({ field: 'supplyMode', value: 'mint', because: 'your wallet holds the mint authority, so the cross can take it over in the same transaction and mint only at the clearing price' });
    suggestions.push({ field: 'presetId', value: 'sealed-launch', because: 'a token the cross will mint is a launch' });
    suggestions.push({ field: 'listingType', value: 'ownership-coin', because: 'a token whose supply the cross will create and then fix' });
    if (t.supply > 0n) notes.push('Some supply is already minted. The cross will add to it, so the supply buyers see after settlement is the existing supply plus what the cross mints.');
  } else if (t.mintAuthority === null) {
    suggestions.push({ field: 'supplyMode', value: 'escrow', because: 'the mint authority is revoked, so the cross cannot mint: it sells tokens you deposit into escrow' });
    suggestions.push({ field: 'presetId', value: 'reopen', because: 'a fixed-supply token is sold from escrow' });
    suggestions.push({ field: 'listingType', value: 'existing-token', because: 'the token already exists with a fixed supply' });
    if (t.supply === 0n) blockers.push('The supply is fixed at zero: there is nothing to sell.');
  } else if (wallet === null) {
    notes.push('A mint authority is still set on this token. Connect the wallet that holds it to mint through a cross, or have the authority revoked to sell tokens you hold from escrow.');
  } else {
    blockers.push('Your wallet is not the mint authority and the authority is not revoked. Connect the wallet that holds it, or have the authority moved to this wallet, to mint through a cross. To sell tokens you already hold, the authority must be revoked so the supply is fixed.');
  }
  return { facts, suggestions, blockers, notes };
}

/** The quote mints other crosses use, most used first, from a list of crosses' quote mints. A mint is never invented: it is offered only if a cross already uses it. */
export function rankQuoteMints(used: readonly string[]): { mint: string; crosses: number }[] {
  const counts = new Map<string, number>();
  for (const m of used) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()].map(([mint, crosses]) => ({ mint, crosses })).sort((a, b) => b.crosses - a.crosses || (a.mint < b.mint ? -1 : 1));
}
