// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// Eligibility diagnostics (PRODUCT_FEATURES [G6]): says exactly why a wallet can or cannot hold a gated token, from
// the same accounts the program reads, so the explanation never differs from the refusal.
import { type Address, type ReadonlyUint8Array, fetchEncodedAccounts, type Rpc, type GetMultipleAccountsApi } from '@solana/kit';
import { type IdentityRecord, FLAG, unpackIdentityData } from './identity';
import { type Rules, CountryPolicy, getTermsDecoder } from './generated/index';
import { CROSS_GATE_PROGRAM_ADDRESS } from './generated/programs/index';
import { decodeIdentityBinding } from './accounts';
import { findConfigPda } from './generated/index';
import { findAttestationAddress, findDeniedAddress, findIdentityAddress, findPassAddress, findTermsAddress, SAS_PROGRAM_ADDRESS } from './pdas';
import { countryListed, readRules } from './rules';
import { countryName } from './countries';

export type ChainAccount = { data: ReadonlyUint8Array; owner: Address };
/** Reads accounts by address; `null` for one that does not exist. */
export type AccountReader = (addresses: Address[]) => Promise<(ChainAccount | null)[]>;

export function rpcReader(rpc: Rpc<GetMultipleAccountsApi>): AccountReader {
  return async (addresses) => {
    const accounts = await fetchEncodedAccounts(rpc, addresses);
    return accounts.map((a) => (a.exists ? { data: a.data, owner: a.programAddress } : null));
  };
}

export type ReasonCode =
  | 'NO_GATE'
  | 'NO_RULES'
  | 'DENIED'
  | 'NO_ATTESTATION'
  | 'ATTESTATION_EXPIRED'
  | 'ATTESTATION_MALFORMED'
  | 'COUNTRY_UNKNOWN'
  | 'COUNTRY_NOT_ALLOWED'
  | 'TIER_TOO_LOW'
  | 'MISSING_FLAGS'
  | 'ISSUANCE_NOT_OPEN'
  | 'ISSUANCE_CLOSED'
  | 'HOLDER_CAP_REACHED'
  | 'IDENTITY_HELD_BY_OTHER_WALLET'
  | 'PASS_EXPIRED'
  | 'PASS_NO_LONGER_CONFORMS';

export type Reason = { code: ReasonCode; message: string };

export type Diagnosis = {
  mint: Address;
  wallet: Address;
  /** Holds a live pass right now. */
  hasPass: boolean;
  /** Could claim a pass right now with the attestations on chain. */
  canClaim: boolean;
  /** `hasPass` and nothing wrong with it. */
  eligible: boolean;
  reasons: Reason[];
  rules: Rules | null;
  identity: IdentityRecord | null;
  /**
   * The other wallet this identity was last bound to, if any. A claim must name it (the program checks that its pass is gone
   * before the identity moves), so `claimPassAttested` takes it as `previousHolder`.
   */
  previousHolder: Address | null;
};

const is = (cond: boolean, code: ReasonCode, message: string, out: Reason[]) => {
  if (cond) out.push({ code, message });
};

/** The flag names behind a mask, for messages. */
export function flagNames(mask: number): string[] {
  return (Object.entries(FLAG) as [string, number][]).filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);
}

export type DiagnoseInput = {
  mint: Address;
  wallet: Address;
  now: bigint;
  /** SAS credential and schema for `oc-identity` (from the gate's rules; read automatically if omitted). */
  identitySas?: { credential: Address; schema: Address };
  accreditationSas?: { credential: Address; schema: Address };
  read: AccountReader;
};

/** Reads a SAS attestation account: missing (or not an attestation), expired, or live with its data and expiry. */
export function liveAttestation(acct: ChainAccount | null, now: bigint): { state: 'missing' } | { state: 'expired'; expiry: bigint } | { state: 'live'; data: Uint8Array; expiry: bigint } {
  if (!acct || acct.owner !== SAS_PROGRAM_ADDRESS || acct.data.length < 110 || acct.data[0] !== 2) return { state: 'missing' };
  const d = acct.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const len = dv.getUint32(97, true);
  const data = Uint8Array.from(d.slice(101, 101 + len));
  const expiry = dv.getBigInt64(101 + len + 32, true);
  return expiry !== 0n && expiry <= now ? { state: 'expired', expiry } : { state: 'live', data, expiry };
}

export async function diagnoseEligibility(i: DiagnoseInput): Promise<Diagnosis> {
  const out: Reason[] = [];
  const [config] = await findConfigPda({ mint: i.mint });
  const [pass] = await findPassAddress(i.mint, i.wallet);
  const [terms] = await findTermsAddress(i.mint, i.wallet);
  const [denied] = await findDeniedAddress(i.mint, i.wallet);
  const [cfgAcct, passAcct, termsAcct, deniedAcct] = await i.read([config, pass, terms, denied]);
  const base = { mint: i.mint, wallet: i.wallet, rules: null as Rules | null, identity: null as IdentityRecord | null, previousHolder: null as Address | null };
  if (!cfgAcct || cfgAcct.owner !== CROSS_GATE_PROGRAM_ADDRESS) {
    return { ...base, hasPass: false, canClaim: false, eligible: false, reasons: [{ code: 'NO_GATE', message: 'This token has no cross_gate gate.' }] };
  }
  const rules = readRules(cfgAcct.data);
  const hasPass = !!passAcct && passAcct.owner === CROSS_GATE_PROGRAM_ADDRESS;
  if (!rules) {
    return { ...base, hasPass, canClaim: false, eligible: hasPass, reasons: hasPass ? [] : [{ code: 'NO_RULES', message: 'This gate has no compliance rules: its authority grants passes directly or from an allowlist.' }] };
  }
  const now = i.now;
  let previousHolder: Address | null = null;
  is(!!deniedAcct && deniedAcct.owner === CROSS_GATE_PROGRAM_ADDRESS, 'DENIED', 'This wallet has been blocked by the issuer\'s compliance officer.', out);

  // The terms the wallet holds, or would get from its attestation.
  const identitySas = i.identitySas ?? (rules.identity.__option === 'Some' ? rules.identity.value : undefined);
  let record: IdentityRecord | null = null;
  let expiry = 0n;
  if (termsAcct && termsAcct.owner === CROSS_GATE_PROGRAM_ADDRESS) {
    const t = getTermsDecoder().decode(termsAcct.data);
    record = { identity: Uint8Array.from(t.identity), country: t.country, tier: t.tier, flags: t.flags, cap: t.cap };
    expiry = t.expiresTs;
    is(expiry !== 0n && expiry <= now, 'PASS_EXPIRED', 'This pass has expired; anyone can close it and the wallet must claim again.', out);
  } else if (identitySas) {
    const [att] = await findAttestationAddress(identitySas.credential, identitySas.schema, i.wallet);
    const [attAcct] = await i.read([att]);
    const state = liveAttestation(attAcct ?? null, now);
    if (state.state === 'missing') out.push({ code: 'NO_ATTESTATION', message: 'No identity attestation exists for this wallet. Complete identity verification with the issuer\'s attester.' });
    else if (state.state === 'expired') out.push({ code: 'ATTESTATION_EXPIRED', message: 'The identity attestation for this wallet has expired. Renew verification with the issuer\'s attester.' });
    else {
      try {
        record = unpackIdentityData(state.data);
        expiry = state.expiry;
        // A separate accreditation attester is the only source of the accredited flag.
        const acc = i.accreditationSas ?? (rules.accreditation.__option === 'Some' ? rules.accreditation.value : undefined);
        if (acc) {
          record.flags &= ~FLAG.accredited;
          const [accAddr] = await findAttestationAddress(acc.credential, acc.schema, i.wallet);
          const [accAcct] = await i.read([accAddr]);
          if (liveAttestation(accAcct ?? null, now).state === 'live') record.flags |= FLAG.accredited;
        }
      } catch {
        out.push({ code: 'ATTESTATION_MALFORMED', message: 'The identity attestation for this wallet is not an Opening Cross identity record.' });
      }
    }
  } else {
    out.push({ code: 'NO_ATTESTATION', message: 'This gate accepts no identity attestation and this wallet holds no pass.' });
  }

  if (record) {
    const listed = countryListed(rules.countries, record.country);
    if (rules.countryPolicy !== CountryPolicy.Off) {
      if (record.country === 0) out.push({ code: 'COUNTRY_UNKNOWN', message: 'The verified identity has no country, so it cannot satisfy this token\'s country rule.' });
      else if ((rules.countryPolicy === CountryPolicy.Allow && !listed) || (rules.countryPolicy === CountryPolicy.Deny && listed)) {
        out.push({ code: 'COUNTRY_NOT_ALLOWED', message: `Holders in ${countryName(record.country) ?? `country ${record.country}`} are not permitted for this token.` });
      }
    }
    is(record.tier < rules.minTier, 'TIER_TOO_LOW', `This token requires investor tier ${rules.minTier} or higher; this wallet is tier ${record.tier}.`, out);
    const missing = rules.requiredFlags & ~record.flags;
    is(missing !== 0, 'MISSING_FLAGS', `This wallet lacks: ${flagNames(missing).join(', ')}.`, out);
  }

  if (!hasPass) {
    is(rules.issuanceStart !== 0n && now < rules.issuanceStart, 'ISSUANCE_NOT_OPEN', 'Passes cannot be claimed yet.', out);
    is(rules.issuanceEnd !== 0n && now >= rules.issuanceEnd, 'ISSUANCE_CLOSED', 'Passes can no longer be claimed.', out);
    is(rules.maxPasses !== 0 && rules.passes >= rules.maxPasses, 'HOLDER_CAP_REACHED', 'The investor cap for this token has been reached.', out);
    if (record && rules.oneIdentityOnePass && record.identity.some((b) => b !== 0)) {
      const [binding] = await findIdentityAddress(i.mint, record.identity);
      const [bAcct] = await i.read([binding]);
      if (bAcct && bAcct.owner === CROSS_GATE_PROGRAM_ADDRESS) {
        const b = decodeIdentityBinding(bAcct.data);
        if (b.wallet !== i.wallet) {
          previousHolder = b.wallet;
          const [holderPass] = await findPassAddress(i.mint, b.wallet);
          const [hp] = await i.read([holderPass]);
          is(!!hp && hp.owner === CROSS_GATE_PROGRAM_ADDRESS, 'IDENTITY_HELD_BY_OTHER_WALLET', `This identity already holds a pass on another wallet (${b.wallet}). That pass must end first.`, out);
        }
      }
    }
  } else if (record) {
    // A held pass that the current rules would no longer issue can be closed by anyone.
    const bad = out.some((r) => ['COUNTRY_NOT_ALLOWED', 'COUNTRY_UNKNOWN', 'TIER_TOO_LOW', 'MISSING_FLAGS'].includes(r.code));
    if (bad) out.push({ code: 'PASS_NO_LONGER_CONFORMS', message: 'This pass no longer satisfies the current rules and can be closed by anyone.' });
  }

  const blocking = out.length > 0;
  return { ...base, rules, identity: record, previousHolder, hasPass, canClaim: !hasPass && !blocking && record !== null, eligible: hasPass && !blocking, reasons: out };
}
