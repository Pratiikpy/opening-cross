import { countryNumeric } from './countries.js';

export const COUNTRY_BYTES = 125;

/** Numeric ISO 3166-1 code for an alpha-2 code or a numeric code; throws for anything that is not a country. */
export function countryBit(code: string | number): number {
  const n = typeof code === 'number' ? code : countryNumeric(code);
  if (n === undefined || !Number.isInteger(n) || n < 0 || n > 999) throw new Error(`not an ISO 3166-1 country: ${String(code)}`);
  return n;
}
