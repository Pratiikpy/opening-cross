// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// The rule check the program applies when it issues a pass and when anyone asks it to close a pass that no longer
// satisfies the rules (`Rules::conforms`), in TypeScript for keepers and UIs. The program is the authority; the
// LiteSVM suite runs the same cases through both.
import type { Rules } from './generated/index';
import { CountryPolicy } from './generated/index';
import { countryListed } from './rules';

export type TermsView = { country: number; tier: number; flags: number };

export type Conformance = { ok: true } | { ok: false; code: 'COUNTRY_UNKNOWN' | 'COUNTRY_NOT_ALLOWED' | 'TIER_TOO_LOW' | 'MISSING_FLAGS' };

export function conforms(rules: Pick<Rules, 'countryPolicy' | 'countries' | 'minTier' | 'requiredFlags'>, t: TermsView): Conformance {
  if (rules.countryPolicy !== CountryPolicy.Off) {
    if (t.country === 0) return { ok: false, code: 'COUNTRY_UNKNOWN' };
    const listed = countryListed(rules.countries, t.country);
    if (rules.countryPolicy === CountryPolicy.Allow ? !listed : listed) return { ok: false, code: 'COUNTRY_NOT_ALLOWED' };
  }
  if (t.tier < rules.minTier) return { ok: false, code: 'TIER_TOO_LOW' };
  if ((t.flags & rules.requiredFlags) !== rules.requiredFlags) return { ok: false, code: 'MISSING_FLAGS' };
  return { ok: true };
}
