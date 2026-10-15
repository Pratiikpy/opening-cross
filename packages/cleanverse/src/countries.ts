// Countries as Cleanverse names them (ISO 3166-1 alpha-2, the appendix of the API reference) and as the gate stores them
// (ISO 3166-1 numeric). The numeric table is the gate client's, so both sides agree by construction; this module adds the
// provider's own list so every code Cleanverse can send is known to map.
import { countryAlpha2, countryNumeric } from '@opening-cross/cross-gate-client';

/** The 194 alpha-2 codes of the "ISO 3166-1 Country Or Region Codes" appendix of the Cleanverse API v5.6 reference. */
export const CLEANVERSE_ALPHA2: readonly string[] = (
  'AD AE AF AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CF CG CH CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'
).split(' ');

export class UnknownCountryError extends Error {
  constructor(readonly code: string) {
    super(`not an ISO 3166-1 alpha-2 country code: ${JSON.stringify(code)}`);
    this.name = 'UnknownCountryError';
  }
}

/** Numeric ISO 3166-1 code for an alpha-2 code (case-insensitive, as the API normalises to upper case). Throws if unknown. */
export function alpha2ToNumeric(alpha2: string): number {
  const n = /^[A-Za-z]{2}$/.test(alpha2) ? countryNumeric(alpha2.toUpperCase()) : undefined;
  if (n === undefined) throw new UnknownCountryError(alpha2);
  return n;
}

/** Alpha-2 code for a numeric code, or `undefined` for 0 (unknown) and unassigned numbers. */
export function numericToAlpha2(numeric: number): string | undefined {
  return countryAlpha2(numeric);
}
