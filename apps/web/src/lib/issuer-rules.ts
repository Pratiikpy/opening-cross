// The rules step, turned into what the API takes and into what bidders will read.
//
// `buildRules` reads the form (human units) and produces the `rules` object of POST /v1/tx/create-cross-ruled and POST /v1/rules/check,
// naming every field it cannot read. It does not decide whether a rule set is acceptable: that is the SDK's `checkRules`, which the API
// runs, so the wizard asks the API (`checkRulesRemote`) and shows the same sentences the API would refuse with. `bidderView` is written
// from the `rules` object, not from the form, so the preview says what is actually committed.
import { isAddress } from '@solana/kit';
import { EMPTY_RULES_FORM, RULE_LIMITS, type RulesForm, rulesFormIsEmpty } from '@opening-cross/presets/rules';
import { API_URL } from './api';
import { type Market, formatAtoms, parseAtoms, parsePrice } from './units';

/** The flag bits of `rules.flags` (`FLAG_*` in cross-core-client; a test compares them). */
export const FLAGS = { resumesHalt: 1 << 1, feedsLenders: 1 << 2, standardGrid: 1 << 3, guardScaledUi: 1 << 4 } as const;
/** The fifth flag (`FLAG_GOVERNED_GRADUATION`, ADR-0656), kept apart from FLAGS so the API's parity test of those four stays as it is; test/w4b-rules-flag.test.ts compares it. */
export const GOVERNED_GRADUATION_FLAG = 1 << 5;

export type RulesJson = {
  flags?: number;
  guards?: { minRaiseQuote?: string; maxMatched?: string; totalSupply?: string; minFloatBps?: number; maxFdvX100?: number; anchorPrice?: string; moveBps?: number; gridEstimate?: string; haltSource?: string };
  ending?: { endingSecs?: number; buckets?: number; cancelCutoffSecs?: number; randomEnd?: boolean; extensionMinSecs?: number; extensionMaxSecs?: number };
  identity?: { capQuote?: string; maxOrders?: number };
  alloc?: { reserveBps?: [number, number, number]; smallCapQuote?: string; lotteryUnit?: string; minLockSecs?: number; lockVestSecs?: number; earlyUntilTs?: string; priorityGate?: string; class1CliffSecs?: number; class1VestSecs?: number };
  neutrality?: { insiders?: string[]; insiderCliffSecs?: number; insiderVestSecs?: number; bondQuote?: string; challengeSecs?: number };
  referral?: { referrer?: string; shareBps?: number };
  oracleSet?: { extraFeeds?: string[]; quorum?: number; maxSpreadBps?: number; offHoursWidenBps?: number };
};

export type RulesUnits = { baseDecimals: number | null; quoteDecimals: number | null; market: Market | null };
export type RulesBuild = {
  /** True when any rule is set; false means the cross is created without the rules extension. */
  active: boolean;
  json: RulesJson | null;
  /** The create-cross-ruled `calendar` field, when a calendar is named. */
  calendar: string | null;
  /** Fields the form could not read, by form key. */
  errors: Partial<Record<keyof RulesForm | `insiders.${number}` | `extraFeeds.${number}`, string>>;
};

const blank = (s: string) => s.trim() === '';
const wholeNumber = (s: string): number | null => (/^\d{1,10}$/.test(s.trim()) ? Number(s.trim()) : null);
/** A percentage with at most two decimals, as basis points. */
const pctToBps = (s: string): number | null => {
  const t = s.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};
const hex32 = (s: string) => /^[0-9a-f]{64}$/.test(s.trim().toLowerCase().replace(/^0x/, ''));
const cleanHex = (s: string) => s.trim().toLowerCase().replace(/^0x/, '');

export function buildRules(f: RulesForm, u: RulesUnits): RulesBuild {
  const errors: RulesBuild['errors'] = {};
  const bad = (k: keyof RulesForm, m: string) => {
    errors[k] = m;
  };
  if (rulesFormIsEmpty(f)) return { active: false, json: null, calendar: null, errors };

  const whole = (k: keyof RulesForm, what: string, scale = 1, max?: number): number | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    const n = wholeNumber(v);
    if (n === null) {
      bad(k, `${what} is a whole number.`);
      return undefined;
    }
    const out = n * scale;
    if (max !== undefined && out > max) {
      bad(k, `${what} is too large.`);
      return undefined;
    }
    return out;
  };
  const bps = (k: keyof RulesForm, what: string, max = 100): number | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    const b = pctToBps(v);
    if (b === null || b > max * 100) {
      bad(k, `${what} is a percentage from 0 to ${max} with at most two decimals.`);
      return undefined;
    }
    return b;
  };
  const quote = (k: keyof RulesForm, what: string): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (u.quoteDecimals === null) {
      bad(k, 'Check the quote token first, so the amount can be read exactly.');
      return undefined;
    }
    const a = parseAtoms(v, u.quoteDecimals);
    if (a === null) {
      bad(k, `${what} is an amount with at most ${u.quoteDecimals} decimal places.`);
      return undefined;
    }
    return a.toString();
  };
  const base = (k: keyof RulesForm, what: string): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (u.baseDecimals === null) {
      bad(k, 'Check the token being sold first, so the amount can be read exactly.');
      return undefined;
    }
    const a = parseAtoms(v, u.baseDecimals);
    if (a === null) {
      bad(k, `${what} is an amount with at most ${u.baseDecimals} decimal places.`);
      return undefined;
    }
    return a.toString();
  };
  const price = (k: keyof RulesForm): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (!u.market) {
      bad(k, 'Check both tokens first, so the price can be read exactly.');
      return undefined;
    }
    const p = parsePrice(v, u.market);
    if (p === null || p === 0n) {
      bad(k, `Enter a price above zero with at most ${u.market.quoteDecimals} decimal places.`);
      return undefined;
    }
    return p.toString();
  };
  const addr = (k: keyof RulesForm): string | undefined => {
    const v = f[k] as string;
    if (blank(v)) return undefined;
    if (!isAddress(v.trim())) {
      bad(k, 'This is not a Solana address.');
      return undefined;
    }
    return v.trim();
  };
  const set = <T extends object>(o: T): T | undefined => (Object.values(o).some((x) => x !== undefined) ? o : undefined);
  const drop = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  // ---- ending
  const ending = set(
    drop({
      endingSecs: whole('endingMins', 'The ending period', 60, 0xffff_ffff),
      buckets: whole('buckets', 'The number of buckets', 1, 255),
      cancelCutoffSecs: whole('cancelCutoffMins', 'The cancel cutoff', 60, 0xffff_ffff),
      randomEnd: f.drawnEnd ? true : undefined,
      extensionMinSecs: whole('extensionMinMins', 'The shortest extension', 60, 0xffff_ffff),
      extensionMaxSecs: whole('extensionMaxMins', 'The longest extension', 60, 0xffff_ffff),
    }),
  );

  // ---- guards
  let maxFdvX100: number | undefined;
  if (!blank(f.maxFdvRatio)) {
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(f.maxFdvRatio.trim())) bad('maxFdvRatio', 'Enter a ratio such as 20 or 12.5, with at most two decimals.');
    else maxFdvX100 = Math.round(Number(f.maxFdvRatio.trim()) * 100);
  }
  const moveBps = bps('movePct', 'The price-move bound', RULE_LIMITS.maxMoveBps / 100);
  let flags = 0;
  if (f.resumesHalt) flags |= FLAGS.resumesHalt;
  if (f.feedsLenders) flags |= FLAGS.feedsLenders;
  if (f.standardGrid) flags |= FLAGS.standardGrid;
  if (f.guardScaledUi) flags |= FLAGS.guardScaledUi;
  if (f.governedGraduation) flags |= GOVERNED_GRADUATION_FLAG;
  const guards = set(
    drop({
      minRaiseQuote: quote('minRaise', 'The minimum raise'),
      maxMatched: base('maxDelivered', 'The cap'),
      totalSupply: base('declaredSupply', 'The declared supply'),
      minFloatBps: bps('minFloatPct', 'The minimum float'),
      maxFdvX100,
      anchorPrice: price('anchorPrice'),
      moveBps,
      gridEstimate: price('gridEstimate'),
      haltSource: addr('haltSource'),
    }),
  );

  // ---- identity
  const identity = set(drop({ capQuote: quote('identityCap', 'The cap per identity'), maxOrders: whole('identityMaxOrders', 'The orders per identity', 1, 255) }));

  // ---- allocation
  const shares = [bps('reserveSmallPct', 'The small-buyer share'), bps('reserveLockedPct', 'The locked share'), bps('reservePriorityPct', 'The priority share')];
  let earlyUntilTs: string | undefined;
  if (!blank(f.earlyUntil)) {
    const t = new Date(f.earlyUntil).getTime();
    if (!Number.isFinite(t)) bad('earlyUntil', 'Enter the deadline as a date and time.');
    else earlyUntilTs = String(Math.floor(t / 1000));
  }
  const alloc = set(
    drop({
      reserveBps: shares.some((x) => x !== undefined) ? ([shares[0] ?? 0, shares[1] ?? 0, shares[2] ?? 0] as [number, number, number]) : undefined,
      smallCapQuote: quote('smallCap', 'The small-order cap'),
      lotteryUnit: base('lotteryLot', 'The lot size'),
      minLockSecs: whole('minLockDays', 'The minimum lockup', 86_400, 0xffff_ffff),
      lockVestSecs: whole('lockVestDays', 'The vesting period', 86_400, 0xffff_ffff),
      earlyUntilTs,
      priorityGate: addr('priorityGate'),
      class1CliffSecs: whole('class1CliffDays', 'The cliff', 86_400, 0xffff_ffff),
      class1VestSecs: whole('class1VestDays', 'The vesting period', 86_400, 0xffff_ffff),
    }),
  );

  // ---- neutrality
  const insiders: string[] = [];
  f.insiders.forEach((a, i) => {
    if (blank(a)) return;
    if (!isAddress(a.trim())) errors[`insiders.${i}`] = 'This is not a Solana address.';
    else insiders.push(a.trim());
  });
  const neutrality = set(
    drop({
      insiders: insiders.length ? insiders : undefined,
      insiderCliffSecs: whole('insiderCliffDays', 'The cliff', 86_400, 0xffff_ffff),
      insiderVestSecs: whole('insiderVestDays', 'The vesting period', 86_400, 0xffff_ffff),
      bondQuote: quote('bond', 'The bond'),
      challengeSecs: whole('challengeDays', 'The challenge window', 86_400, 0xffff_ffff),
    }),
  );

  // ---- oracle set
  const feeds: string[] = [];
  f.extraFeeds.forEach((x, i) => {
    if (blank(x)) return;
    if (!hex32(x)) errors[`extraFeeds.${i}`] = 'A Pyth feed id is 64 hexadecimal characters (32 bytes).';
    else feeds.push(cleanHex(x));
  });
  const oracleSet = set(
    drop({
      extraFeeds: feeds.length ? feeds : undefined,
      quorum: whole('quorum', 'The quorum', 1, 255),
      maxSpreadBps: bps('maxSpreadPct', 'The spread limit'),
      offHoursWidenBps: bps('offHoursWidenPct', 'The off-hours widening', RULE_LIMITS.maxWidenBps / 100),
    }),
  );

  // ---- referral
  const referrer = addr('referrer');
  const share = bps('referralSharePct', 'The referral share', RULE_LIMITS.maxReferralBps / 100);
  const referral = set(drop({ referrer, shareBps: share }));

  const calendar = addr('calendar');
  const json: RulesJson = drop({ flags: flags || undefined, guards, ending, identity, alloc, neutrality, referral, oracleSet });
  return { active: true, json, calendar: calendar ?? null, errors };
}

// ------------------------------------------------------------------------------------------------ asking the API

export type RuleIssue = { code: string; field: string; message: string };

/** Which form field an issue's `field` (`ending.buckets`, `neutrality.insiders[2]`) belongs to. */
export function formKeyForIssue(field: string): keyof RulesForm | null {
  const table: Record<string, keyof RulesForm> = {
    flags: 'resumesHalt',
    'guards.minRaiseQuote': 'minRaise',
    'guards.maxMatched': 'maxDelivered',
    'guards.totalSupply': 'declaredSupply',
    'guards.minFloatBps': 'minFloatPct',
    'guards.maxFdvX100': 'maxFdvRatio',
    'guards.anchorPrice': 'anchorPrice',
    'guards.moveBps': 'movePct',
    'guards.gridEstimate': 'gridEstimate',
    'guards.haltSource': 'haltSource',
    ending: 'endingMins',
    'ending.endingSecs': 'endingMins',
    'ending.buckets': 'buckets',
    'ending.cancelCutoffSecs': 'cancelCutoffMins',
    'ending.randomEnd': 'drawnEnd',
    'ending.extensionMinSecs': 'extensionMinMins',
    'ending.extensionMaxSecs': 'extensionMaxMins',
    identity: 'identityCap',
    'identity.capQuote': 'identityCap',
    'identity.maxOrders': 'identityMaxOrders',
    alloc: 'reserveSmallPct',
    'alloc.reserveBps': 'reserveSmallPct',
    'alloc.smallCapQuote': 'smallCap',
    'alloc.lotteryUnit': 'lotteryLot',
    'alloc.minLockSecs': 'minLockDays',
    'alloc.lockVestSecs': 'lockVestDays',
    'alloc.earlyUntilTs': 'earlyUntil',
    'alloc.priorityGate': 'priorityGate',
    'alloc.class1CliffSecs': 'class1CliffDays',
    'alloc.class1VestSecs': 'class1VestDays',
    'neutrality.insiders': 'insiders',
    'neutrality.insiderCliffSecs': 'insiderCliffDays',
    'neutrality.insiderVestSecs': 'insiderVestDays',
    'neutrality.bondQuote': 'bond',
    'neutrality.challengeSecs': 'challengeDays',
    oracleSet: 'extraFeeds',
    'oracleSet.extraFeeds': 'extraFeeds',
    'oracleSet.quorum': 'quorum',
    'oracleSet.maxSpreadBps': 'maxSpreadPct',
    'oracleSet.offHoursWidenBps': 'offHoursWidenPct',
    referral: 'referralSharePct',
    'referral.referrer': 'referrer',
    'referral.shareBps': 'referralSharePct',
  };
  const plain = field.replace(/\[\d+\]/, '');
  return table[plain] ?? null;
}

export type RemoteCheck = { ok: true; issues: RuleIssue[] } | { ok: false; error: string };

/** POST /v1/rules/check: the SDK's `checkRules`, run by the API on exactly the body the creation would send. Nothing is built or stored. */
export async function checkRulesRemote(createBody: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteCheck> {
  try {
    const res = await fetch(`${API_URL}/v1/rules/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody), ...(signal ? { signal } : {}) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; issues?: RuleIssue[]; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `The API answered HTTP ${res.status}.` };
    return { ok: true, issues: body.issues ?? [] };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return { ok: false, error: 'The Opening Cross API could not be reached, so these rules could not be checked.' };
  }
}

// ------------------------------------------------------------------------------------------------ what the transactions will be

export type CreateSizes = { createAndRules: number; withPrefix: number; firstTransactions: number };
export type SizeResult =
  | { ok: true; sizes: CreateSizes; transactions: number; cross: string }
  | { ok: false; reason: 'TX_TOO_LARGE'; error: string; bytes: number | null }
  | { ok: false; reason: 'OTHER'; error: string };

export const TRANSACTION_LIMIT = 1_232;

/** Builds (never signs) the creation to learn its size: POST /v1/tx/create-cross-ruled answers `sizes`, or 422 TX_TOO_LARGE. */
export async function measureCreation(createBody: Record<string, unknown>, signal?: AbortSignal): Promise<SizeResult> {
  try {
    const res = await fetch(`${API_URL}/v1/tx/create-cross-ruled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody), ...(signal ? { signal } : {}) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; bytes?: number; sizes?: CreateSizes; transactions?: unknown[]; cross?: string };
    if (res.ok && body.sizes && body.transactions && body.cross) return { ok: true, sizes: body.sizes, transactions: body.transactions.length, cross: body.cross };
    if (body.reason === 'TX_TOO_LARGE') return { ok: false, reason: 'TX_TOO_LARGE', error: body.error ?? 'The rules do not fit the transaction.', bytes: typeof body.bytes === 'number' ? body.bytes : null };
    return { ok: false, reason: 'OTHER', error: body.error ?? `The API answered HTTP ${res.status}.` };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return { ok: false, reason: 'OTHER', error: 'The Opening Cross API could not be reached, so the size could not be measured.' };
  }
}

/** The plain statement of the size: one transaction, or the two the program needs when the first would be over the limit. */
export function sizeStatement(r: Extract<SizeResult, { ok: true }>): { tone: 'ok' | 'warn'; text: string } {
  const { createAndRules, withPrefix, firstTransactions } = r.sizes;
  if (firstTransactions === 1) {
    return { tone: 'ok', text: `The opening transaction is ${withPrefix} of the ${TRANSACTION_LIMIT} bytes a transaction holds: your quote token account, the creation and the rules all go in one.` };
  }
  return {
    tone: 'warn',
    text: `Everything in one transaction would be ${withPrefix} bytes, over the ${TRANSACTION_LIMIT} a transaction holds, so it is sent as two, in order. First your quote token account (and, in a minting cross, the handover of the mint authority). Then the creation with the rules, ${createAndRules} bytes. The rules cannot move out of the creation transaction: the program accepts them only in the slot the cross is created in.`,
  };
}

// ------------------------------------------------------------------------------------------------ what bidders will see

export type ViewItem = { id: string; title: string; text: string };
export type ViewContext = { baseDecimals: number | null; quoteDecimals: number | null; openMs: number | null; closeMs: number | null };

const fmtMins = (secs: number) => (secs % 3600 === 0 && secs >= 3600 ? `${secs / 3600} hour${secs === 3600 ? '' : 's'}` : secs % 60 === 0 ? `${secs / 60} minute${secs === 60 ? '' : 's'}` : `${secs} seconds`);
const fmtDays = (secs: number) => (secs % 86_400 === 0 ? `${secs / 86_400} day${secs === 86_400 ? '' : 's'}` : fmtMins(secs));
const q = (v: string, d: number | null) => (d === null ? `${v} quote atoms` : `${formatAtoms(BigInt(v), d)} quote`);
const t = (v: string, d: number | null) => (d === null ? `${v} base atoms` : `${formatAtoms(BigInt(v), d)} tokens`);
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** What a bidder is told about the rules, one sentence-sized item each. Empty when no rule is set. */
export function bidderView(r: RulesJson | null, c: ViewContext): ViewItem[] {
  if (!r) return [];
  const out: ViewItem[] = [];
  const e = r.ending;
  if (e?.endingSecs) {
    const buckets = e.buckets ?? 0;
    const closeNote = c.closeMs !== null ? ` The call closes at ${utc(c.closeMs)}.` : '';
    out.push({
      id: 'ending',
      title: `Final ${fmtMins(e.endingSecs)}: ${buckets} buckets`,
      text: `The last ${fmtMins(e.endingSecs)} before the close is cut into ${buckets} equal buckets, and your order belongs to the bucket of the moment it lands.${e.randomEnd ? ' After the close the cluster draws which bucket is the last one counted: orders in later buckets are not counted and are refunded in full. A bid placed early loses nothing; a bid placed at the last moment may be left out.' : ''} While the final period is open the page shows only the nearest price band and whether demand or supply leads, not the exact price.${closeNote}`,
    });
  }
  if (e?.cancelCutoffSecs && c.closeMs !== null && e.endingSecs !== undefined) {
    out.push({ id: 'cancel', title: 'Cancels close before the end', text: `You can cancel an order until ${utc(c.closeMs - (e.endingSecs + e.cancelCutoffSecs) * 1000)}, ${fmtMins(e.endingSecs + e.cancelCutoffSecs)} before the close. After that an order cannot be cancelled, but it is still refunded in full if the cross does not print or its bucket is not counted.` });
  } else if (e?.cancelCutoffSecs) {
    out.push({ id: 'cancel', title: 'Cancels close before the end', text: `Cancels close ${fmtMins(e.cancelCutoffSecs)} before the final period begins. After that an order cannot be cancelled, but it is still refunded in full if the cross does not print.` });
  }
  if (e?.extensionMaxSecs) out.push({ id: 'extension', title: 'One possible extension', text: `If the cross fails one of its guards, the call opens again once, for a length drawn between ${fmtMins(e.extensionMinSecs ?? 0)} and ${fmtMins(e.extensionMaxSecs)}. Orders placed in the extension cannot be cancelled, and the second clear is final.` });

  const g = r.guards;
  if (g?.minRaiseQuote) out.push({ id: 'min-raise', title: `Prints only if it raises ${q(g.minRaiseQuote, c.quoteDecimals)}`, text: 'Below that amount the cross does not print and every bidder is refunded in full.' });
  if (g?.maxMatched) out.push({ id: 'cap', title: `At most ${t(g.maxMatched, c.baseDecimals)} are sold`, text: 'This hard cap is published before the first order. It is not a choice made after seeing the book.' });
  if (g?.minFloatBps) out.push({ id: 'float', title: `Public float of at least ${pct(g.minFloatBps)}`, text: `At least ${pct(g.minFloatBps)} of all tokens must end up with buyers, not counting declared insiders, or the cross does not print.${g.totalSupply ? ` The supply is declared as ${t(g.totalSupply, c.baseDecimals)}.` : ''}` });
  if (g?.maxFdvX100) out.push({ id: 'fdv', title: `Value at most ${(g.maxFdvX100 / 100).toFixed(2).replace(/\.?0+$/, '')} times the raise`, text: 'If the price would value all tokens at more than that multiple of the amount raised, the cross does not print.' });
  if (g?.moveBps) out.push({ id: 'move', title: `Price within ${pct(g.moveBps)} of the anchor`, text: 'If the clearing price lands further than that from the anchor, nothing executes and every order is refunded. Place a new order in the follow-up cross.' });
  if (g?.gridEstimate && ((r.flags ?? 0) & FLAGS.standardGrid) !== 0) out.push({ id: 'grid', title: 'Standard price grid', text: 'The first price is at least half the published estimate, steps are at most one percent of it, and the estimate lies inside the grid.' });
  if (((r.flags ?? 0) & FLAGS.guardScaledUi) !== 0) out.push({ id: 'scaled-ui', title: 'Voided if the share multiplier changes', text: 'If a stock split or similar action changes the token’s scaled-UI multiplier while the cross is open, the cross does not print.' });
  if (((r.flags ?? 0) & FLAGS.resumesHalt) !== 0) out.push({ id: 'resume', title: 'Lifts a trading halt', text: 'This cross is the one that lifts the halt on its token. It does so only if it prints.' });
  if (((r.flags ?? 0) & GOVERNED_GRADUATION_FLAG) !== 0) out.push({ id: 'governed', title: 'Graduates by holder vote', text: 'The market opens only on the venue holders vote for. The creator sets a charter before the first order; holders lock tokens behind a venue and the settlement program refuses a pool on any other.' });
  if (((r.flags ?? 0) & FLAGS.feedsLenders) !== 0) out.push({ id: 'lenders', title: 'Feeds the lender price', text: 'A print here can update the price lenders read, only if enough tokens trade.' });

  const id = r.identity;
  if (id?.maxOrders || id?.capQuote) {
    const parts = [id.maxOrders ? `${id.maxOrders === 1 ? 'one order' : `${id.maxOrders} orders`}` : null, id.capQuote ? `at most ${q(id.capQuote, c.quoteDecimals)} escrowed in open buy orders` : null].filter(Boolean);
    out.push({ id: 'identity', title: 'Limits per verified identity', text: `Each wallet that holds the cross’s gate pass may have ${parts.join(' and ')}. Cancelling an order frees the room.` });
  }

  const a = r.alloc;
  const [s = 0, l = 0, p = 0] = a?.reserveBps ?? [];
  if (s > 0 && a?.smallCapQuote) {
    out.push({ id: 'class-small', title: `Small verified buyers: ${pct(s)} reserved`, text: `Orders up to ${q(a.smallCapQuote, c.quoteDecimals)} from a verified identity are class 1. When a price level is oversubscribed, ${pct(s)} of it goes to class 1 first.${a.lotteryUnit ? ` Class 1 orders are one lot of ${t(a.lotteryUnit, c.baseDecimals)} each, and winners are drawn.` : ' They share it pro rata.'}` });
  }
  if (l > 0 && a?.minLockSecs) out.push({ id: 'class-locked', title: `Buyers who accept a lockup: ${pct(l)} reserved`, text: `Choose class 2 and a lockup of at least ${fmtDays(a.minLockSecs)}${a.lockVestSecs ? `, then vesting over ${fmtDays(a.lockVestSecs)}` : ''}. When a level is oversubscribed, ${pct(l)} of it goes to locked buyers first, weighted by lock length. Better-priced orders still fill in full.` });
  if (p > 0) out.push({ id: 'class-priority', title: `Priority buyers: ${pct(p)} reserved`, text: `${[a?.earlyUntilTs ? `orders committed before ${utc(Number(a.earlyUntilTs) * 1000)}` : null, a?.priorityGate ? 'holders of the priority pass' : null].filter(Boolean).join(' and ')} share ${pct(p)} of an oversubscribed level first. Committing early improves priority and never the price.` });
  if (a?.class1CliffSecs || a?.class1VestSecs) out.push({ id: 'class1-vest', title: 'Small-buyer fills vest', text: `Class 1 fills unlock after ${fmtDays(a.class1CliffSecs ?? 0)} and then vest over ${fmtDays(a.class1VestSecs ?? 0)}.` });

  const n = r.neutrality;
  if (n?.insiders?.length) {
    out.push({ id: 'insiders', title: `${n.insiders.length} declared insider${n.insiders.length === 1 ? '' : 's'}`, text: `These wallets are declared as the team’s. Their orders are tallied apart, ${n.insiderCliffSecs || n.insiderVestSecs ? `their fills unlock after ${fmtDays(n.insiderCliffSecs ?? 0)} and vest over ${fmtDays(n.insiderVestSecs ?? 0)}, ` : ''}and they do not count toward the minimum volume, the raise or the float.` });
  }
  if (n?.bondQuote) out.push({ id: 'bond', title: `Issuer bond of ${q(n.bondQuote, c.quoteDecimals)}`, text: `Anyone may challenge a wallet they believe belongs to the team and was not declared, for ${fmtDays(n.challengeSecs ?? 0)} after the clear. An upheld challenge slashes the bond.` });

  const o = r.oracleSet;
  if (o?.extraFeeds?.length) out.push({ id: 'oracles', title: `${o.extraFeeds.length + 1} oracles must agree`, text: `The reference is the median of the usable prices; ${o.quorum ?? 1} must be fresh and verified${o.maxSpreadBps ? `, and they may differ by at most ${pct(o.maxSpreadBps)}` : ''}. Otherwise the cross does not print.` });
  if (o?.offHoursWidenBps) out.push({ id: 'off-hours', title: 'Wider oracle band outside market hours', text: `The allowed difference from the oracle widens by ${pct(o.offHoursWidenBps)} while the calendar’s market is closed.` });

  const ref = r.referral;
  if (ref?.shareBps) out.push({ id: 'referral', title: 'A referrer shares the protocol fee', text: `${pct(ref.shareBps)} of the protocol’s fee, not of anything you pay beyond it, goes to the referrer. Your price and the integrator’s fee are unchanged.` });
  return out;
}

/** The create-cross body's `rules`, `calendar` and (when the lender feed flag is set) nothing else: the pieces the wizard adds to the plain body. */
export function rulesBodyPart(b: RulesBuild): Record<string, unknown> {
  if (!b.active || !b.json) return {};
  return { rules: b.json, ...(b.calendar ? { calendar: b.calendar } : {}) };
}

export { EMPTY_RULES_FORM };
