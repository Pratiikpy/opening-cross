// The issuer's rules form: a jurisdiction preset fills it in, the issuer edits it, and `buildAdminRules` turns it into the
// rules the program takes, or says exactly what is wrong. Pure, so every rule of the form is tested without a browser.
import { isAddress } from '@solana/kit';
import { parseAtoms } from '../../../lib/units';
import { CountryPolicy, FLAG, type PresetId, type Rules, type RulesArgs, buildRules, countryAlpha2, countryNumeric, listedCountries, preset } from './gate-client';

export type AdminForm = {
  countryPolicy: 'off' | 'allow' | 'deny';
  /** ISO 3166-1 alpha-2 codes separated by commas or spaces. */
  countries: string;
  minTier: '0' | '1' | '2' | '3';
  kyc: boolean;
  sanctions: boolean;
  accredited: boolean;
  oneIdentity: boolean;
  /** Investor cap; empty = none. */
  maxPasses: string;
  /** Per-person cap in whole quote tokens; empty = none. */
  defaultCap: string;
  /** Resale lock in days; empty = none. */
  lockDays: string;
  lockDelegate: string;
  identityCredential: string;
  identitySchema: string;
  accreditationCredential: string;
  accreditationSchema: string;
  allowlistRoot: string;
  /** First day passes can be claimed and the day they stop being claimable (UTC dates, yyyy-mm-dd); empty = unbounded. */
  issuanceStart: string;
  issuanceEnd: string;
  /** Up to four windows: the first day tokens are frozen for insiders and the day they may move again. */
  blackouts: { start: string; resumes: string }[];
  affiliateWindowDays: string;
  /** Whole tokens an insider may sell in one window. */
  affiliateMax: string;
  /** Live passes issued before the rules existed (first switch-on only). */
  preexistingPasses: string;
};

export type FormDecimals = { quote: number; token: number | null };

export const EMPTY_FORM: AdminForm = {
  countryPolicy: 'off',
  countries: '',
  minTier: '0',
  kyc: false,
  sanctions: false,
  accredited: false,
  oneIdentity: true,
  maxPasses: '',
  defaultCap: '',
  lockDays: '',
  lockDelegate: '',
  identityCredential: '',
  identitySchema: '',
  accreditationCredential: '',
  accreditationSchema: '',
  allowlistRoot: '',
  issuanceStart: '',
  issuanceEnd: '',
  blackouts: [],
  affiliateWindowDays: '',
  affiliateMax: '',
  preexistingPasses: '0',
};

const DAY = 86_400n;
const TIERS = ['0', '1', '2', '3'] as const;

/** A jurisdiction preset's rules as a filled-in form. `restricted` is the exclusion list counsel supplies; the preset ships none. */
export function formFromPreset(id: PresetId, restricted: readonly string[], quoteDecimals: number): AdminForm {
  const p = preset(id, { restrictedCountries: restricted, quoteUnit: 10n ** BigInt(quoteDecimals) });
  const r = p.rules;
  const flags = r.requiredFlags ?? 0;
  return {
    ...EMPTY_FORM,
    countryPolicy: r.countryPolicy ?? 'off',
    countries: (r.countries ?? []).map((c) => (typeof c === 'number' ? String(c) : c)).join(', '),
    minTier: TIERS[r.minTier ?? 0] ?? '0',
    kyc: (flags & FLAG.kyc) !== 0,
    sanctions: (flags & FLAG.sanctionsClear) !== 0,
    accredited: (flags & FLAG.accredited) !== 0,
    oneIdentity: r.oneIdentityOnePass ?? true,
    defaultCap: r.defaultCap && r.defaultCap > 0n ? (r.defaultCap / 10n ** BigInt(quoteDecimals)).toString() : '',
    lockDays: p.resaleLockSecs > 0n ? (p.resaleLockSecs / DAY).toString() : '',
  };
}

const parseCodes = (text: string): string[] => text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);

/** A UTC calendar date as unix seconds, or null if it is not a real date. */
export function utcDate(text: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return BigInt(ms / 1000);
}

const whole = (text: string, max: number): number | null => (/^\d{1,9}$/.test(text.trim()) && Number(text) <= max ? Number(text) : null);

export type Built = { ok: true; rules: RulesArgs } | { ok: false; problems: string[] };

/** The rules the program takes from the form, or every problem with it, in the words an issuer needs. */
export function buildAdminRules(f: AdminForm, d: FormDecimals): Built {
  const problems: string[] = [];
  const codes = parseCodes(f.countries);
  const bad = codes.filter((c) => countryNumeric(c) === undefined);
  if (bad.length) problems.push(`Not ISO 3166-1 country codes: ${bad.join(', ')}.`);
  if (f.countryPolicy === 'allow' && codes.length === 0) problems.push('An allow list needs at least one country; otherwise no one can hold the token.');
  if (f.countryPolicy === 'off' && codes.length > 0) problems.push('Countries are listed but the country rule is off. Choose allow or deny, or clear the list.');

  const maxPasses = f.maxPasses.trim() === '' ? 0 : whole(f.maxPasses, 4_294_967_295);
  if (maxPasses === null) problems.push('The investor cap is a whole number of holders.');
  const passes = whole(f.preexistingPasses || '0', 4_294_967_295);
  if (passes === null) problems.push('Passes issued before the rules is a whole number.');

  let defaultCap = 0n;
  if (f.defaultCap.trim() !== '') {
    const v = parseAtoms(f.defaultCap, d.quote);
    if (v === null) problems.push(`The per-person limit is an amount with at most ${d.quote} decimals.`);
    else defaultCap = v;
  }
  let lockSecs = 0n;
  if (f.lockDays.trim() !== '') {
    const days = whole(f.lockDays, 36_500);
    if (days === null || days === 0) problems.push('The resale lock is a whole number of days, at least 1.');
    else lockSecs = BigInt(days) * DAY;
  }
  if (f.lockDelegate.trim() !== '' && !isAddress(f.lockDelegate.trim())) problems.push('The lock keeper is not a Solana address.');

  const pair = (a: string, b: string, what: string) => {
    const x = a.trim();
    const y = b.trim();
    if (x === '' && y === '') return null;
    if (!isAddress(x) || !isAddress(y)) {
      problems.push(`${what}: give both the SAS credential and the schema, as Solana addresses.`);
      return null;
    }
    return { credential: x as never, schema: y as never };
  };
  const identity = pair(f.identityCredential, f.identitySchema, 'Identity attester');
  const accreditation = pair(f.accreditationCredential, f.accreditationSchema, 'Accreditation attester');
  if (f.accredited && !accreditation && !identity) problems.push('Accredited-only needs an attester that can say who is accredited: set the identity or the accreditation attester.');

  let allowlistRoot: Uint8Array | null = null;
  if (f.allowlistRoot.trim() !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(f.allowlistRoot.trim())) problems.push('The allowlist root is 64 hexadecimal characters.');
    else allowlistRoot = Uint8Array.from(f.allowlistRoot.trim().match(/../g)!.map((h) => parseInt(h, 16)));
  }

  const issuanceStart = f.issuanceStart.trim() === '' ? 0n : utcDate(f.issuanceStart);
  const issuanceEnd = f.issuanceEnd.trim() === '' ? 0n : utcDate(f.issuanceEnd);
  if (issuanceStart === null) problems.push('The first claim day is not a date (yyyy-mm-dd).');
  if (issuanceEnd === null) problems.push('The last claim day is not a date (yyyy-mm-dd).');
  if (issuanceStart && issuanceEnd && issuanceStart >= issuanceEnd) problems.push('Passes must stop being claimable after they start.');

  const blackouts: { start: bigint; end: bigint }[] = [];
  if (f.blackouts.length > 4) problems.push('At most four blackout windows.');
  f.blackouts.forEach((w, i) => {
    const start = utcDate(w.start);
    const end = utcDate(w.resumes);
    if (start === null || end === null) problems.push(`Blackout ${i + 1}: both dates are needed (yyyy-mm-dd).`);
    else if (start >= end) problems.push(`Blackout ${i + 1}: trading must resume after it starts.`);
    else blackouts.push({ start, end });
  });

  let affiliateLimit: { windowSecs: bigint; maxAmount: bigint } | null = null;
  if (f.affiliateWindowDays.trim() !== '' || f.affiliateMax.trim() !== '') {
    const days = whole(f.affiliateWindowDays, 36_500);
    if (days === null || days === 0) problems.push('The insider volume window is a whole number of days, at least 1.');
    if (d.token === null) problems.push('The token\'s decimals could not be read, so the insider volume limit cannot be set yet.');
    const max = d.token === null ? null : parseAtoms(f.affiliateMax, d.token);
    if (d.token !== null && (max === null || max === 0n)) problems.push(`The insider volume limit is an amount above zero with at most ${d.token} decimals.`);
    if (days && days > 0 && max && max > 0n) affiliateLimit = { windowSecs: BigInt(days) * DAY, maxAmount: max };
  }

  if (problems.length > 0 || maxPasses === null || passes === null || issuanceStart === null || issuanceEnd === null) return { ok: false, problems };
  const requiredFlags = (f.kyc ? FLAG.kyc : 0) | (f.sanctions ? FLAG.sanctionsClear : 0) | (f.accredited ? FLAG.accredited : 0);
  return {
    ok: true,
    rules: buildRules({
      countryPolicy: f.countryPolicy,
      countries: codes,
      minTier: Number(f.minTier),
      requiredFlags,
      oneIdentityOnePass: f.oneIdentity,
      maxPasses,
      passes,
      defaultCap,
      issuanceStart,
      issuanceEnd,
      identity,
      accreditation,
      allowlistRoot,
      lockPolicy: lockSecs > 0n ? { durationSecs: lockSecs } : null,
      lockDelegate: f.lockDelegate.trim() === '' ? null : (f.lockDelegate.trim() as never),
      blackouts,
      affiliateLimit,
    }),
  };
}

const dateOf = (ts: bigint): string => (ts === 0n ? '' : new Date(Number(ts) * 1000).toISOString().slice(0, 10));
const decimal = (atoms: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const frac = (atoms % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${atoms / unit}${frac ? `.${frac}` : ''}`;
};
const some = <T>(o: { __option: 'Some'; value: T } | { __option: 'None' }): T | null => (o.__option === 'Some' ? o.value : null);

/**
 * The rules a gate has now, as a form to edit. Dates are shown as the UTC days they fall on, so a window the program holds to the
 * second is rounded to the day: the form edits rules written by this form, and shows others as faithfully as a day allows.
 */
export function formFromRules(rules: Rules, d: FormDecimals): AdminForm {
  const countries = listedCountries(rules).map((n) => countryAlpha2(n) ?? String(n));
  const identity = some(rules.identity);
  const accreditation = some(rules.accreditation);
  const root = some(rules.allowlistRoot);
  const lock = some(rules.lockPolicy);
  const limit = some(rules.affiliateLimit);
  const delegate = some(rules.lockDelegate);
  return {
    countryPolicy: rules.countryPolicy === CountryPolicy.Allow ? 'allow' : rules.countryPolicy === CountryPolicy.Deny ? 'deny' : 'off',
    countries: countries.join(', '),
    minTier: TIERS[rules.minTier] ?? '0',
    kyc: (rules.requiredFlags & FLAG.kyc) !== 0,
    sanctions: (rules.requiredFlags & FLAG.sanctionsClear) !== 0,
    accredited: (rules.requiredFlags & FLAG.accredited) !== 0,
    oneIdentity: rules.oneIdentityOnePass,
    maxPasses: rules.maxPasses > 0 ? String(rules.maxPasses) : '',
    defaultCap: rules.defaultCap > 0n ? decimal(rules.defaultCap, d.quote) : '',
    lockDays: lock ? String(Math.max(1, Math.round(Number(lock.durationSecs) / 86_400))) : '',
    lockDelegate: delegate ?? '',
    identityCredential: identity?.credential ?? '',
    identitySchema: identity?.schema ?? '',
    accreditationCredential: accreditation?.credential ?? '',
    accreditationSchema: accreditation?.schema ?? '',
    allowlistRoot: root ? Array.from(root, (x) => x.toString(16).padStart(2, '0')).join('') : '',
    issuanceStart: dateOf(rules.issuanceStart),
    issuanceEnd: dateOf(rules.issuanceEnd),
    blackouts: rules.blackouts.filter((w) => w.start < w.end).map((w) => ({ start: dateOf(w.start), resumes: dateOf(w.end) })),
    affiliateWindowDays: limit ? String(Math.max(1, Math.round(Number(limit.windowSecs) / 86_400))) : '',
    affiliateMax: limit && d.token !== null ? decimal(limit.maxAmount, d.token) : '',
    preexistingPasses: '0',
  };
}
