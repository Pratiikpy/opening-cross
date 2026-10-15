// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// Rule presets for the offering types the specification names (PRODUCT_FEATURES [G1, G2, V6]). A preset is a set of
// gate rules plus the plain-language notes an issuer and their counsel need to read next to it. THESE ARE TEMPLATES,
// NOT LEGAL ADVICE: a preset must be approved by counsel for the actual offering before it is used with public money
// (docs/HUMAN_TASKS.md H2). Nothing here lists embargoed jurisdictions: that list changes and belongs to counsel, so
// every preset takes it as an explicit argument.
import type { RulesInput } from './rules';
import { FLAG, Tier } from './identity';

export type PresetId = 'reg-d-506c' | 'reg-s' | 'reg-cf' | 'mica' | 'vara' | 'open';

export type Preset = {
  id: PresetId;
  name: string;
  /** One sentence for an issuer: who may hold the token under this preset. */
  summary: string;
  rules: RulesInput;
  /** Resale lock, in seconds, to apply to tokens bought in the offering (0 = none). Needs `lockPolicy` or a lock delegate. */
  resaleLockSecs: bigint;
  notes: string[];
  /** Primary sources for the rule, so counsel can check the preset against the text. */
  sources: string[];
  /** Always true: a preset is never legal clearance. */
  requiresCounsel: true;
};

export type PresetParams = {
  /** ISO 3166-1 alpha-2 codes of jurisdictions the issuer's counsel has told it to exclude. Required, may be empty. */
  restrictedCountries: readonly string[];
  /** Quote-token atoms in one whole quote unit (for example 1_000_000n for a 6-decimal stablecoin), to express caps. */
  quoteUnit?: bigint;
};

const DAY = 86_400n;

/** EU member states plus Iceland, Liechtenstein and Norway (the EEA), as ISO 3166-1 alpha-2 codes. */
export const EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
] as const;

const KYC = FLAG.kyc | FLAG.sanctionsClear;

const minus = (list: readonly string[], drop: readonly string[]) => list.filter((c) => !drop.includes(c));

/**
 * Builds a preset. `restrictedCountries` is applied as a deny list where the preset has no allow list, and removed
 * from the allow list where it has one.
 */
export function preset(id: PresetId, p: PresetParams): Preset {
  const unit = p.quoteUnit ?? 1_000_000n;
  const restricted = p.restrictedCountries.map((c) => c.toUpperCase());
  switch (id) {
    case 'reg-d-506c':
      return {
        id,
        name: 'Regulation D, Rule 506(c)',
        summary: 'Accredited investors only, each verified by a third party, with a twelve-month resale lock.',
        rules: { countryPolicy: restricted.length ? 'deny' : 'off', countries: restricted, minTier: Tier.accredited, requiredFlags: FLAG.accredited | KYC, oneIdentityOnePass: true },
        resaleLockSecs: 365n * DAY,
        notes: [
          'Rule 506(c) requires the issuer to take reasonable steps to verify that every purchaser is an accredited investor; a self-declaration is not enough. Connect an accreditation attester (oc-accreditation) that checks letters or documents.',
          'A one-year holding period applies to restricted securities of a non-reporting issuer (Rule 144(d)). The preset applies it as a resale lock on tokens received in the cross.',
          'Form D must be filed and state notice requirements may apply; the program cannot do this for the issuer.',
          'Securities Exchange Act section 12(g) holder-of-record thresholds are not set here; set maxPasses if counsel wants an investor cap on chain.',
        ],
        sources: ['17 CFR 230.506(c)', '17 CFR 230.144'],
        requiresCounsel: true,
      };
    case 'reg-s':
      return {
        id,
        name: 'Regulation S',
        summary: 'Non-US persons only, with a one-year distribution compliance period on resale.',
        rules: { countryPolicy: 'deny', countries: ['US', ...restricted], minTier: Tier.retail, requiredFlags: KYC, oneIdentityOnePass: true },
        resaleLockSecs: 365n * DAY,
        notes: [
          'The gate checks the country in the identity attestation, which is the country of the verified identity document. Regulation S turns on whether the buyer is a US person and is outside the United States at the time of the order; the attester must establish that, the program only enforces what is attested.',
          'The distribution compliance period depends on the issuer category (one year for equity of a non-reporting US issuer, shorter in other cases). 365 days is the conservative default; counsel sets the real period.',
          'Offers into the United States, directed selling efforts and resales to US persons during the period are outside the control of this program.',
        ],
        sources: ['17 CFR 230.901 to 230.905'],
        requiresCounsel: true,
      };
    case 'reg-cf':
      return {
        id,
        name: 'Regulation Crowdfunding',
        summary: 'US residents, retail allowed, with a per-investor annual limit and a twelve-month resale restriction.',
        rules: { countryPolicy: 'allow', countries: minus(['US'], restricted), minTier: Tier.retail, requiredFlags: KYC, oneIdentityOnePass: true, defaultCap: 2_500n * unit },
        resaleLockSecs: 365n * DAY,
        notes: [
          'Regulation CF limits what one person may invest across all Reg CF offerings in twelve months, by income and net worth. The preset sets the lowest tier as the default cap per identity; the identity attester raises the cap for an investor whose income and net worth allow more, and is responsible for aggregating across offerings.',
          'Reg CF offerings run through a registered funding portal or broker-dealer. This program does not replace that intermediary.',
          'Securities issued under Reg CF may not be resold for one year except to the issuer, to accredited investors, to family members and in a few other cases; the preset applies a resale lock for the period.',
        ],
        sources: ['17 CFR Part 227', '17 CFR 227.501'],
        requiresCounsel: true,
      };
    case 'mica':
      return {
        id,
        name: 'MiCA (EEA)',
        summary: 'Verified residents of the EU and EEA states, retail allowed.',
        rules: { countryPolicy: 'allow', countries: minus(EEA, restricted), minTier: Tier.retail, requiredFlags: KYC, oneIdentityOnePass: true },
        resaleLockSecs: 0n,
        notes: [
          'MiCA regulates crypto-assets that are not financial instruments. A tokenised share or other security falls under MiFID II and national securities law instead, and MiCA does not apply to it.',
          'An offer to the public needs a crypto-asset white paper notified to the home regulator, and a regulated or exempt offeror. The gate restricts who may hold the token; it does not satisfy those obligations.',
        ],
        sources: ['Regulation (EU) 2023/1114'],
        requiresCounsel: true,
      };
    case 'vara':
      return {
        id,
        name: 'VARA (Dubai)',
        summary: 'Verified holders in the United Arab Emirates.',
        rules: { countryPolicy: 'allow', countries: minus(['AE'], restricted), minTier: Tier.retail, requiredFlags: KYC, oneIdentityOnePass: true },
        resaleLockSecs: 0n,
        notes: [
          'VARA licenses virtual asset activities in Dubai and publishes rulebooks including marketing and offering rules, with extra requirements for retail. The gate restricts holders by attested country; licensing and disclosure remain the issuer\'s and its distributor\'s.',
        ],
        sources: ['Dubai Law No. 4 of 2022 on the Regulation of Virtual Assets'],
        requiresCounsel: true,
      };
    case 'open':
      return {
        id,
        name: 'Open, screened',
        summary: 'Anyone who passes KYC and a sanctions screen, outside the jurisdictions counsel excludes.',
        rules: { countryPolicy: restricted.length ? 'deny' : 'off', countries: restricted, minTier: Tier.retail, requiredFlags: KYC, oneIdentityOnePass: true },
        resaleLockSecs: 0n,
        notes: ['This preset adds identity checks and a deny list to a token that is otherwise unrestricted. It is not a securities exemption.'],
        sources: [],
        requiresCounsel: true,
      };
  }
}

export const PRESET_IDS: readonly PresetId[] = ['reg-d-506c', 'reg-s', 'reg-cf', 'mica', 'vara', 'open'];
