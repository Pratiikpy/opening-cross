// A gate's rules in plain English, for the pages and messages that show them to holders and issuers. Pure: the words come from
// the rules the chain holds and nothing else, so what a screen says and what the program enforces cannot drift apart.
import { FLAG } from './identity.js';
import { type Rules, CountryPolicy } from './generated/index.js';
import { countryAlpha2, countryName } from './countries.js';
import { countryListed } from './rules.js';

/** What a tier means in the rules (`min_tier`). */
export const TIER_REQUIREMENT = ['any investor', 'retail investor or above', 'accredited investor or above', 'qualified investor'] as const;
/** The tier a holder is recorded at. */
export const TIER_NAME = ['unspecified', 'retail', 'accredited', 'qualified'] as const;

const FLAG_REQUIREMENT: readonly [number, string][] = [
  [FLAG.kyc, 'identity (KYC) verification'],
  [FLAG.sanctionsClear, 'a sanctions screen'],
  [FLAG.accredited, 'accredited-investor status'],
];

/** The ISO 3166-1 numeric codes a rules country list names, in ascending order. */
export function listedCountries(rules: Pick<Rules, 'countries'>): number[] {
  const out: number[] = [];
  for (let n = 0; n < 1000; n++) if (countryListed(rules.countries, n)) out.push(n);
  return out;
}

/** "India, United Kingdom" for up to `max` countries, "212 countries" beyond. Names that contain a comma are separated by semicolons. */
export function countryList(numerics: readonly number[], max = 8): string {
  if (numerics.length > max) return `${numerics.length} countries`;
  const names = numerics.map((n) => countryName(n) ?? countryAlpha2(n) ?? `country ${n}`);
  return names.join(names.some((n) => n.includes(',')) ? '; ' : ', ');
}

const days = (secs: bigint): string => {
  const d = Number(secs) / 86_400;
  return d >= 1 ? `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}` : `${Math.round(Number(secs) / 3_600)} hour${Math.round(Number(secs) / 3_600) === 1 ? '' : 's'}`;
};

const date = (ts: bigint): string => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

const some = <T>(o: { __option: 'Some'; value: T } | { __option: 'None' }): T | null => (o.__option === 'Some' ? o.value : null);

/** Amounts in quote atoms, written as a decimal with the quote token's symbol. */
function amount(atoms: bigint, decimals: number, symbol: string): string {
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  const frac = (atoms % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''} ${symbol}`;
}

export type DescribeOptions = { quoteDecimals?: number; quoteSymbol?: string; tokenDecimals?: number; tokenSymbol?: string };

/**
 * One sentence per rule that is switched on, in the order a holder cares about: who is let in, then how much, then what
 * restrictions follow the tokens. An empty list means the rules add nothing beyond the pass itself.
 */
export function requirementLines(rules: Rules, o: DescribeOptions = {}): string[] {
  const out: string[] = [];
  const countries = listedCountries(rules);
  if (rules.countryPolicy === CountryPolicy.Allow) out.push(`Holders in ${countryList(countries)} only.`);
  if (rules.countryPolicy === CountryPolicy.Deny && countries.length > 0) out.push(`No holders in ${countryList(countries)}.`);
  if (rules.minTier > 0) out.push(`${TIER_REQUIREMENT[rules.minTier] ?? `Tier ${rules.minTier}`}.`.replace(/^./, (c) => c.toUpperCase()));
  for (const [bit, name] of FLAG_REQUIREMENT) if (rules.requiredFlags & bit) out.push(`Requires ${name}.`);
  if (rules.oneIdentityOnePass) out.push('One wallet per verified person.');
  if (rules.maxPasses > 0) out.push(`At most ${rules.maxPasses} holders (${rules.passes} so far).`);
  if (rules.defaultCap > 0n) out.push(`Each person may commit up to ${o.quoteDecimals !== undefined ? amount(rules.defaultCap, o.quoteDecimals, o.quoteSymbol ?? 'quote tokens') : `${rules.defaultCap} quote atoms`} per cross unless the attester sets a different limit.`);
  if (rules.issuanceStart !== 0n || rules.issuanceEnd !== 0n) {
    out.push(
      rules.issuanceStart !== 0n && rules.issuanceEnd !== 0n
        ? `Passes can be claimed from ${date(rules.issuanceStart)} until ${date(rules.issuanceEnd)}.`
        : rules.issuanceStart !== 0n
          ? `Passes can be claimed from ${date(rules.issuanceStart)}.`
          : `Passes can be claimed until ${date(rules.issuanceEnd)}.`,
    );
  }
  const lock = some(rules.lockPolicy);
  if (lock) out.push(`Tokens bought in the offering cannot be resold for ${days(lock.durationSecs)}.`);
  for (const w of rules.blackouts) if (w.start < w.end) out.push(`Insiders cannot transfer tokens from ${date(w.start)} until ${date(w.end)}.`);
  const limit = some(rules.affiliateLimit);
  if (limit) out.push(`Insiders may sell at most ${o.tokenDecimals !== undefined ? amount(limit.maxAmount, o.tokenDecimals, o.tokenSymbol ?? 'tokens') : `${limit.maxAmount} token atoms`} in any ${days(limit.windowSecs)}.`);
  return out;
}

/** Facts about how the gate is set up that an issuer or holder should know and the requirement lines do not say. */
export function setupNotes(rules: Rules, mode: 'Allowlist' | 'Open'): string[] {
  const out: string[] = [];
  if (some(rules.identity) === null && some(rules.accreditation) === null && some(rules.allowlistRoot) === null) {
    out.push('No identity attester or terms allowlist is set, so only the gate authority can issue passes.');
  }
  if (mode === 'Open') out.push('The gate is open: the rules decide who may bid in a cross, but anyone may receive the token by transfer.');
  if (rules.blackouts.some((w) => w.start < w.end) || some(rules.affiliateLimit)) out.push('Blackout windows and volume limits apply to wallets flagged as insiders, and can be avoided by moving tokens to a wallet that is not one.');
  return out;
}
