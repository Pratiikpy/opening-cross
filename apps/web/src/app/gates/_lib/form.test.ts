import { describe, expect, it } from 'vitest';
import { CountryPolicy, FLAG, buildRules, countryListed, countryNumeric, getRulesDecoder, getRulesEncoder, requirementLines } from './gate-client';
import { EMPTY_FORM, type AdminForm, type FormDecimals, buildAdminRules, formFromPreset, formFromRules, utcDate } from './form';

const D: FormDecimals = { quote: 6, token: 6 };
const SAS = { credential: '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr', schema: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' };
const withAttester = (f: AdminForm): AdminForm => ({ ...f, identityCredential: SAS.credential, identitySchema: SAS.schema });
const problems = (f: AdminForm, d = D) => {
  const b = buildAdminRules(f, d);
  return b.ok ? [] : b.problems;
};

describe('presets fill the form', () => {
  it('Regulation S excludes the United States and locks for a year', () => {
    const f = formFromPreset('reg-s', ['KP'], 6);
    expect(f.countryPolicy).toBe('deny');
    expect(f.countries.split(', ').sort()).toEqual(['KP', 'US']);
    expect(f.lockDays).toBe('365');
    expect(f.kyc && f.sanctions).toBe(true);
  });

  it('Regulation CF allows the United States only, minus the exclusion list, with the per-person limit in whole tokens', () => {
    const f = formFromPreset('reg-cf', [], 6);
    expect(f).toMatchObject({ countryPolicy: 'allow', countries: 'US', defaultCap: '2500', lockDays: '365' });
    expect(formFromPreset('reg-cf', ['US'], 6).countries).toBe('');
  });

  it('Rule 506(c) wants accredited investors and a verifier', () => {
    const f = formFromPreset('reg-d-506c', [], 6);
    expect(f).toMatchObject({ minTier: '2', accredited: true, kyc: true });
    expect(problems(f)[0]).toMatch(/needs an attester/);
    expect(problems(withAttester(f))).toEqual([]);
  });

  it('every preset builds into rules once an attester is named', () => {
    for (const id of ['reg-d-506c', 'reg-s', 'reg-cf', 'mica', 'vara', 'open'] as const) {
      const b = buildAdminRules(withAttester(formFromPreset(id, ['KP'], 6)), D);
      expect(b.ok, id).toBe(true);
    }
  });
});

describe('what the form builds', () => {
  it('turns the issuer\'s choices into the rules the program takes', () => {
    const f: AdminForm = {
      ...withAttester(EMPTY_FORM),
      countryPolicy: 'allow',
      countries: 'in, gb',
      minTier: '2',
      kyc: true,
      accredited: true,
      accreditationCredential: SAS.credential,
      accreditationSchema: SAS.schema,
      maxPasses: '99',
      defaultCap: '1,500.5',
      lockDays: '180',
      issuanceStart: '2027-02-01',
      issuanceEnd: '2027-03-01',
      blackouts: [{ start: '2027-04-01', resumes: '2027-04-15' }],
      affiliateWindowDays: '90',
      affiliateMax: '1000',
      preexistingPasses: '3',
    };
    const b = buildAdminRules(f, D);
    if (!b.ok) throw new Error(b.problems.join(' '));
    expect(b.rules).toMatchObject({ countryPolicy: CountryPolicy.Allow, minTier: 2, requiredFlags: FLAG.kyc | FLAG.accredited, maxPasses: 99, passes: 3, defaultCap: 1_500_500_000n });
    expect(countryListed(b.rules.countries, countryNumeric('IN')!) && countryListed(b.rules.countries, countryNumeric('GB')!)).toBe(true);
    expect(b.rules.issuanceStart).toBe(utcDate('2027-02-01'));
    expect(b.rules.blackouts[0]).toEqual({ start: utcDate('2027-04-01'), end: utcDate('2027-04-15') });
    expect(b.rules.blackouts[1]).toEqual({ start: 0n, end: 0n });
    expect(b.rules.lockPolicy).toEqual({ durationSecs: 180n * 86_400n });
    expect(b.rules.affiliateLimit).toEqual({ windowSecs: 90n * 86_400n, maxAmount: 1_000_000_000n });
  });

  it('what the gate page tells a holder is what the issuer set', () => {
    const f = { ...withAttester(formFromPreset('reg-s', [], 6)), blackouts: [{ start: '2027-01-15', resumes: '2027-01-26' }] };
    const b = buildAdminRules(f, D);
    if (!b.ok) throw new Error(b.problems.join(' '));
    const onChain = getRulesDecoder().decode(getRulesEncoder().encode(b.rules));
    expect(requirementLines(onChain, { quoteDecimals: 6, quoteSymbol: 'USDC' })).toEqual([
      'No holders in United States of America.',
      'Retail investor or above.',
      'Requires identity (KYC) verification.',
      'Requires a sanctions screen.',
      'One wallet per verified person.',
      'Tokens bought in the offering cannot be resold for 365 days.',
      'Insiders cannot transfer tokens from 2027-01-15 until 2027-01-26.',
    ]);
  });
});

describe('what the form refuses, and says', () => {
  it('names every problem, not only the first', () => {
    const list = problems({ ...EMPTY_FORM, countryPolicy: 'allow', countries: 'XX, in', maxPasses: '-3', lockDays: '0', affiliateWindowDays: 'x', affiliateMax: '5' });
    expect(list.join(' ')).toMatch(/Not ISO 3166-1 country codes: XX/);
    expect(list.join(' ')).toMatch(/investor cap/);
    expect(list.join(' ')).toMatch(/resale lock/);
    expect(list.join(' ')).toMatch(/volume window/);
  });

  it('an allow list with no countries would admit no one', () => {
    expect(problems({ ...EMPTY_FORM, countryPolicy: 'allow' })[0]).toMatch(/at least one country/);
  });

  it('countries without a country rule are a mistake, not a rule', () => {
    expect(problems({ ...EMPTY_FORM, countries: 'US' })[0]).toMatch(/country rule is off/);
  });

  it('an attester needs both its credential and its schema, as addresses', () => {
    expect(problems({ ...EMPTY_FORM, identityCredential: SAS.credential })[0]).toMatch(/both/);
    expect(problems({ ...EMPTY_FORM, identityCredential: 'abc', identitySchema: SAS.schema })[0]).toMatch(/both/);
  });

  it('rejects impossible dates, backwards windows and too many blackouts', () => {
    expect(problems({ ...EMPTY_FORM, issuanceStart: '2027-02-30' }).join(' ')).toMatch(/not a date/);
    expect(problems({ ...EMPTY_FORM, issuanceStart: '2027-03-01', issuanceEnd: '2027-02-01' }).join(' ')).toMatch(/stop being claimable after/);
    expect(problems({ ...EMPTY_FORM, blackouts: [{ start: '2027-02-01', resumes: '2027-02-01' }] }).join(' ')).toMatch(/resume after it starts/);
    expect(problems({ ...EMPTY_FORM, blackouts: Array.from({ length: 5 }, () => ({ start: '2027-02-01', resumes: '2027-02-02' })) }).join(' ')).toMatch(/At most four/);
  });

  it('cannot price a volume limit without the token\'s decimals, and refuses more precision than the token has', () => {
    const f = { ...EMPTY_FORM, affiliateWindowDays: '30', affiliateMax: '10' };
    expect(problems(f, { quote: 6, token: null }).join(' ')).toMatch(/decimals could not be read/);
    expect(problems({ ...f, affiliateMax: '1.0000001' }).join(' ')).toMatch(/at most 6 decimals/);
    expect(problems({ ...f, affiliateMax: '0' }).join(' ')).toMatch(/above zero/);
  });

  it('checks the allowlist root and the lock keeper', () => {
    expect(problems({ ...EMPTY_FORM, allowlistRoot: 'xyz' }).join(' ')).toMatch(/64 hexadecimal/);
    expect(problems({ ...EMPTY_FORM, lockDelegate: 'nope' }).join(' ')).toMatch(/lock keeper/);
    expect(problems({ ...EMPTY_FORM, allowlistRoot: 'ab'.repeat(32), lockDelegate: SAS.credential })).toEqual([]);
  });
});

describe('dates', () => {
  it('are UTC midnights and refuse what is not a calendar day', () => {
    expect(utcDate('2027-01-15')).toBe(1_799_971_200n);
    expect(utcDate('2024-02-29')).not.toBeNull();
    expect(utcDate('2027-02-29')).toBeNull();
    expect(utcDate('15/01/2027')).toBeNull();
    expect(utcDate('')).toBeNull();
  });
});

describe('the form for rules already on chain', () => {
  it('shows what the issuer set, and building it again gives the same rules', () => {
    const f: AdminForm = {
      ...withAttester(EMPTY_FORM),
      countryPolicy: 'deny',
      countries: 'KP, US',
      minTier: '1',
      kyc: true,
      sanctions: true,
      maxPasses: '250',
      defaultCap: '2500.25',
      lockDays: '365',
      lockDelegate: SAS.credential,
      allowlistRoot: 'cd'.repeat(32),
      issuanceStart: '2027-02-01',
      issuanceEnd: '2027-03-01',
      blackouts: [{ start: '2027-04-01', resumes: '2027-04-15' }, { start: '2027-07-01', resumes: '2027-07-08' }],
      affiliateWindowDays: '90',
      affiliateMax: '12.5',
    };
    const built = buildAdminRules(f, D);
    if (!built.ok) throw new Error(built.problems.join(' '));
    const onChain = getRulesDecoder().decode(getRulesEncoder().encode(built.rules));
    const back = formFromRules(onChain, D);
    expect(back).toEqual({ ...f, countries: 'KP, US', preexistingPasses: '0' });
    const again = buildAdminRules(back, D);
    if (!again.ok) throw new Error(again.problems.join(' '));
    expect(again.rules).toEqual(built.rules);
  });

  it('shows an empty rule set as an empty form', () => {
    const onChain = getRulesDecoder().decode(getRulesEncoder().encode(buildRules({})));
    expect(formFromRules(onChain, D)).toEqual(EMPTY_FORM);
  });
});
