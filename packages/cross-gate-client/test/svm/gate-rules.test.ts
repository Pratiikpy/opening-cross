// cross_gate compliance rules (ADR-0900), against the real program and the mainnet SAS binary: opting a gate into
// rules, every way of obtaining a pass with terms (SAS identity attestation, terms-bearing allowlist, authority
// grant), every refusal (country, tier, flags, holder cap, issuance window, denial, one pass per identity) and every
// way a pass ends (authority, expiry, attestation closed, rules tightened, wallet denied).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, address } from '@solana/kit';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCloseAttestationInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import {
  ACCREDITATION_SCHEMA,
  FLAG,
  IDENTITY_SCHEMA,
  Mode,
  Tier,
  CONFIG_BASE_SIZE,
  RULES_EXT_SIZE,
  type IdentityRecord,
  allowWallet,
  blockWallet,
  buildRules,
  claimPassAttested,
  claimPassMerkleTerms,
  countryNumeric,
  decodeIdentityBinding,
  findConfigPda,
  findIdentityAddress,
  findPassAddress,
  findTermsAddress,
  denyWallet,
  diagnoseEligibility,
  type AccountReader,
  getClaimPassInstruction,
  getCreateConfigInstruction,
  getGrantPassInstruction,
  getRevokePassInstruction,
  getSetAllowlistRootInstruction,
  getSetSasRequirementInstruction,
  getTermsDecoder,
  grantPassTerms,
  initRules,
  packIdentityData,
  readRules,
  refreshTerms,
  revokeDenied,
  revokeExpired,
  revokeNonconforming,
  revokePassTerms,
  setRules,
  type RulesInput,
} from '../../src/index.js';
import { buildTermsAllowlist } from '../../../presets/src/gate-allowlist.js';
import { World } from '../../../../tests/core/src/world.js';
import { T0 } from '../../../../tests/core/src/harness.js';

const SAS = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
const SO = fileURLToPath(new URL('../../../../tests/fixtures/solana_attestation_service.so', import.meta.url));
const ix = (x: unknown) => x as Instruction; // sas-lib targets kit 5; instructions are plain data
const IN = countryNumeric('IN')!;
const US = countryNumeric('US')!;
const GB = countryNumeric('GB')!;
const id32 = (n: number) => new Uint8Array(32).fill(n);
const rec = (n: number, o: Partial<IdentityRecord> = {}): IdentityRecord => ({ identity: id32(n), country: IN, tier: Tier.retail, flags: FLAG.kyc | FLAG.sanctionsClear, cap: 0n, ...o });

async function setup(rules: RulesInput = {}) {
  const w = await World.create();
  w.h.svm.addProgramFromFile(SAS, SO);
  const attester = await w.h.wallet();
  const accreditor = await w.h.wallet();
  const [credential] = await deriveCredentialPda({ authority: attester.address, name: 'oc-attester' });
  const [identitySchema] = await deriveSchemaPda({ credential, name: IDENTITY_SCHEMA.name, version: IDENTITY_SCHEMA.version });
  await w.h.send([ix(getCreateCredentialInstruction({ payer: attester, credential, authority: attester, name: 'oc-attester', signers: [attester.address] } as never))], attester);
  await w.h.send([ix(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema: identitySchema, name: IDENTITY_SCHEMA.name, description: IDENTITY_SCHEMA.description, layout: IDENTITY_SCHEMA.layout, fieldNames: [...IDENTITY_SCHEMA.fieldNames] } as never))], attester);
  const [accCredential] = await deriveCredentialPda({ authority: accreditor.address, name: 'oc-accreditor' });
  const [accSchema] = await deriveSchemaPda({ credential: accCredential, name: ACCREDITATION_SCHEMA.name, version: ACCREDITATION_SCHEMA.version });
  await w.h.send([ix(getCreateCredentialInstruction({ payer: accreditor, credential: accCredential, authority: accreditor, name: 'oc-accreditor', signers: [accreditor.address] } as never))], accreditor);
  await w.h.send([ix(getCreateSchemaInstruction({ payer: accreditor, authority: accreditor, credential: accCredential, schema: accSchema, name: ACCREDITATION_SCHEMA.name, description: ACCREDITATION_SCHEMA.description, layout: ACCREDITATION_SCHEMA.layout, fieldNames: [...ACCREDITATION_SCHEMA.fieldNames] } as never))], accreditor);

  const mint = await w.h.mint(w.admin, 6);
  const [config] = await findConfigPda({ mint });
  const identitySas = { credential, schema: identitySchema };
  const accreditationSas = { credential: accCredential, schema: accSchema };
  await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);

  const attest = async (subject: Address, r: IdentityRecord, expiry = 0n) => {
    const [attestation] = await deriveAttestationPda({ credential, schema: identitySchema, nonce: subject });
    await w.h.send([ix(getCreateAttestationInstruction({ payer: attester, authority: attester, credential, schema: identitySchema, attestation, nonce: subject, data: packIdentityData(r), expiry } as never))], attester);
    return attestation;
  };
  const closeAttestation = async (attestation: Address) => w.h.send([ix(getCloseAttestationInstruction({ payer: attester, authority: attester, credential, attestation } as never))], attester);
  const accredit = async (subject: Address, expiry = 0n) => {
    const [attestation] = await deriveAttestationPda({ credential: accCredential, schema: accSchema, nonce: subject });
    await w.h.send([ix(getCreateAttestationInstruction({ payer: accreditor, authority: accreditor, credential: accCredential, schema: accSchema, attestation, nonce: subject, data: new Uint8Array([1]), expiry } as never))], accreditor);
  };
  const activate = (r: RulesInput = {}) => initRules({ authority: w.admin, mint, rules: buildRules({ identity: identitySas, ...r }) });
  if (rules && Object.keys(rules).length) await w.h.send([await activate(rules)], w.admin);

  const rulesNow = () => readRules((w.h.svm.getAccount(config) as { data: Uint8Array }).data);
  const termsOf = async (owner: Address) => getTermsDecoder().decode((w.h.svm.getAccount((await findTermsAddress(mint, owner))[0]) as { data: Uint8Array }).data);
  const bindingOf = async (identity: Uint8Array) => decodeIdentityBinding((w.h.svm.getAccount((await findIdentityAddress(mint, identity))[0]) as { data: Uint8Array }).data);
  const has = async (a: Promise<readonly [Address, unknown]>) => w.h.exists((await a)[0]);
  const claim = (owner: Address, r: IdentityRecord, extra: { previousHolder?: Address; accreditation?: boolean; payer?: typeof w.admin } = {}) =>
    claimPassAttested({ payer: extra.payer ?? w.admin, owner, mint, identity: r.identity, identitySas, ...(extra.accreditation ? { accreditationSas } : {}), ...(extra.previousHolder ? { previousHolder: extra.previousHolder } : {}) });
  return { w, mint, config, attester, accreditor, identitySas, accreditationSas, attest, accredit, closeAttestation, activate, rulesNow, termsOf, bindingOf, claim, passAddress: async (o: Address) => (await findPassAddress(mint, o))[0], has };
}

describe.skipIf(!existsSync(SO))('cross_gate compliance rules', () => {
  it('a gate opts into rules: the config grows by exactly the extension, old paths close, only the authority can switch it on, once', async () => {
    const s = await setup();
    const before = (s.w.h.svm.getAccount(s.config) as { data: Uint8Array }).data.length;
    expect(before).toBe(CONFIG_BASE_SIZE);
    expect(s.rulesNow()).toBeNull();
    // A stranger cannot switch rules on.
    const stranger = await s.w.trader();
    expect(await s.w.h.fail([await initRules({ authority: stranger, mint: s.mint, rules: buildRules({ identity: s.identitySas }) })], stranger)).toContain('Unauthorized');
    // Invalid rules are refused before anything is stored.
    expect(await s.w.h.fail([await s.activate({ minTier: 4 })], s.w.admin)).toContain('BadRules');
    expect(await s.w.h.fail([await s.activate({ requiredFlags: 0x80 })], s.w.admin)).toContain('BadRules');
    await s.w.h.send([await s.activate({ countryPolicy: 'allow', countries: ['IN', 'GB'], minTier: Tier.retail, requiredFlags: FLAG.kyc })], s.w.admin);
    expect((s.w.h.svm.getAccount(s.config) as { data: Uint8Array }).data.length).toBe(CONFIG_BASE_SIZE + RULES_EXT_SIZE);
    const r = s.rulesNow()!;
    expect(r.countryPolicy).toBe(1);
    expect(r.minTier).toBe(1);
    expect(r.passes).toBe(0);
    // The original layout is untouched: the first bytes still decode as the same config.
    expect(await s.w.h.fail([await s.activate({})], s.w.admin)).toContain('RulesAlreadyActive');

    // The original issuance and revocation paths are closed once rules are active.
    const alice = await s.w.trader();
    const [pass] = await findPassAddress(s.mint, alice.address);
    expect(await s.w.h.fail([getGrantPassInstruction({ authority: s.w.admin, config: s.config, owner: alice.address, pass } as never)], s.w.admin)).toContain('UseRulesPath');
    expect(await s.w.h.fail([getSetSasRequirementInstruction({ authority: s.w.admin, config: s.config, sas: s.identitySas })], s.w.admin)).toContain('UseRulesPath');
    expect(await s.w.h.fail([getSetAllowlistRootInstruction({ authority: s.w.admin, config: s.config, root: new Uint8Array(32) })], s.w.admin)).toContain('UseRulesPath');
    const att = await s.attest(alice.address, rec(1));
    expect(await s.w.h.fail([getClaimPassInstruction({ payer: s.w.admin, owner: alice.address, config: s.config, attestation: att, pass })], s.w.admin)).toContain('UseRulesPath');
    // The authority can change the rules but not the live-pass counter.
    await s.w.h.send([await setRules({ authority: s.w.admin, mint: s.mint, rules: buildRules({ identity: s.identitySas, countryPolicy: 'deny', countries: ['US'], passes: 99 }) })], s.w.admin);
    expect(s.rulesNow()!.countryPolicy).toBe(2);
    expect(s.rulesNow()!.passes).toBe(0);
    expect(await s.w.h.fail([await setRules({ authority: stranger, mint: s.mint, rules: buildRules({}) })], stranger)).toContain('Unauthorized');
  });

  it('legacy gates keep working exactly as before when rules are never switched on', async () => {
    const s = await setup();
    const alice = await s.w.trader();
    const [pass] = await findPassAddress(s.mint, alice.address);
    await s.w.h.send([getGrantPassInstruction({ authority: s.w.admin, config: s.config, owner: alice.address, pass } as never)], s.w.admin);
    expect(s.w.h.exists(pass)).toBe(true);
    await s.w.h.send([getRevokePassInstruction({ authority: s.w.admin, config: s.config, pass } as never)], s.w.admin);
    expect(s.w.h.exists(pass)).toBe(false);
  });

  it('an attested wallet gets a pass with its terms; the identity is bound and counted', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN'], requiredFlags: FLAG.kyc, defaultCap: 5_000_000n });
    const alice = await s.w.trader();
    const r = rec(1, { tier: Tier.accredited, cap: 2_000_000n });
    await s.attest(alice.address, r, T0 + 10_000n);
    await s.w.h.send([await s.claim(alice.address, r)], s.w.admin);
    expect(s.w.h.exists(await s.passAddress(alice.address))).toBe(true);
    const t = await s.termsOf(alice.address);
    expect([t.country, t.tier, t.flags, t.cap, t.source, t.expiresTs]).toEqual([IN, Tier.accredited, FLAG.kyc | FLAG.sanctionsClear, 2_000_000n, 1, T0 + 10_000n]);
    expect(Array.from(t.identity)).toEqual(Array.from(r.identity));
    expect((await s.bindingOf(r.identity)).wallet).toBe(alice.address);
    expect(s.rulesNow()!.passes).toBe(1);
    // A second claim of the same wallet is refused.
    expect(await s.w.h.fail([await s.claim(alice.address, r)], s.w.admin)).toBeTruthy();
  });

  it('refuses every wallet that fails a rule, and says which', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN', 'GB'], minTier: Tier.accredited, requiredFlags: FLAG.kyc | FLAG.sanctionsClear });
    const who = async (r: IdentityRecord, expiry = 0n) => {
      const u = await s.w.trader();
      await s.attest(u.address, r, expiry);
      return u;
    };
    const wrongCountry = await who(rec(1, { tier: Tier.accredited, country: US }));
    expect(await s.w.h.fail([await s.claim(wrongCountry.address, rec(1, { tier: Tier.accredited, country: US }))], s.w.admin)).toContain('CountryNotAllowed');
    const unknownCountry = await who(rec(2, { tier: Tier.accredited, country: 0 }));
    expect(await s.w.h.fail([await s.claim(unknownCountry.address, rec(2, { tier: Tier.accredited, country: 0 }))], s.w.admin)).toContain('CountryUnknown');
    const lowTier = await who(rec(3, { tier: Tier.retail, country: GB }));
    expect(await s.w.h.fail([await s.claim(lowTier.address, rec(3, { tier: Tier.retail, country: GB }))], s.w.admin)).toContain('TierTooLow');
    const noFlag = await who(rec(4, { tier: Tier.accredited, flags: FLAG.kyc }));
    expect(await s.w.h.fail([await s.claim(noFlag.address, rec(4, { tier: Tier.accredited, flags: FLAG.kyc }))], s.w.admin)).toContain('MissingFlags');
    // An attestation that has expired, one for another wallet and none at all are all refused.
    const expired = await who(rec(5, { tier: Tier.accredited }), T0 + 100n);
    s.w.h.setTime(T0 + 100n);
    expect(await s.w.h.fail([await s.claim(expired.address, rec(5, { tier: Tier.accredited }))], s.w.admin)).toContain('AttestationInvalid');
    s.w.h.setTime(T0);
    const eve = await s.w.trader();
    expect(await s.w.h.fail([await s.claim(eve.address, rec(5, { tier: Tier.accredited }))], s.w.admin)).toContain('AttestationInvalid');
    // A wrong identity argument cannot be smuggled in: the program checks it against the attestation.
    const ok = await who(rec(6, { tier: Tier.accredited }));
    expect(await s.w.h.fail([await s.claim(ok.address, rec(7, { tier: Tier.accredited }))], s.w.admin)).toContain('IdentityMismatch');
    await s.w.h.send([await s.claim(ok.address, rec(6, { tier: Tier.accredited }))], s.w.admin);
    expect(s.rulesNow()!.passes).toBe(1);
  });

  it('a deny list works the other way round, and the country list is the whole 1,000-code range', async () => {
    const s = await setup({ countryPolicy: 'deny', countries: ['US', 'KP', 999] });
    const a = await s.w.trader();
    await s.attest(a.address, rec(1, { country: US }));
    expect(await s.w.h.fail([await s.claim(a.address, rec(1, { country: US }))], s.w.admin)).toContain('CountryNotAllowed');
    const b = await s.w.trader();
    await s.attest(b.address, rec(2, { country: 999 }));
    expect(await s.w.h.fail([await s.claim(b.address, rec(2, { country: 999 }))], s.w.admin)).toContain('CountryNotAllowed');
    const c = await s.w.trader();
    await s.attest(c.address, rec(3, { country: GB }));
    await s.w.h.send([await s.claim(c.address, rec(3, { country: GB }))], s.w.admin);
  });

  it('a separate accreditation attester is the only source of the accredited flag', async () => {
    const s = await setup({ requiredFlags: FLAG.accredited, accreditation: undefined });
    // Switch the accreditation attester on.
    await s.w.h.send([await setRules({ authority: s.w.admin, mint: s.mint, rules: buildRules({ identity: s.identitySas, accreditation: s.accreditationSas, requiredFlags: FLAG.accredited }) })], s.w.admin);
    const alice = await s.w.trader();
    // The identity attester claims accreditation itself: ignored.
    const r = rec(1, { flags: FLAG.kyc | FLAG.accredited });
    await s.attest(alice.address, r);
    expect(await s.w.h.fail([await s.claim(alice.address, r, { accreditation: true })], s.w.admin)).toContain('MissingFlags');
    await s.accredit(alice.address, T0 + 500n);
    await s.w.h.send([await s.claim(alice.address, r, { accreditation: true })], s.w.admin);
    const t = await s.termsOf(alice.address);
    expect(t.flags & FLAG.accredited).toBe(FLAG.accredited);
    // The pass lapses with the earlier of the two expiries.
    expect(t.expiresTs).toBe(T0 + 500n);
  });

  it('the investor cap, the issuance window and one pass per identity', async () => {
    const s = await setup({ maxPasses: 2, issuanceStart: T0 + 100n, issuanceEnd: T0 + 1_000n });
    const a = await s.w.trader();
    const b = await s.w.trader();
    const c = await s.w.trader();
    const a2 = await s.w.trader();
    for (const [u, n] of [[a, 1], [b, 2], [c, 3], [a2, 1]] as const) await s.attest(u.address, rec(n));
    expect(await s.w.h.fail([await s.claim(a.address, rec(1))], s.w.admin)).toContain('IssuanceNotOpen');
    s.w.h.setTime(T0 + 100n);
    await s.w.h.send([await s.claim(a.address, rec(1))], s.w.admin);
    // The same person on a second wallet is refused while the first pass lives.
    expect(await s.w.h.fail([await s.claim(a2.address, rec(1), { previousHolder: a.address })], s.w.admin)).toContain('IdentityAlreadyBound');
    await s.w.h.send([await s.claim(b.address, rec(2))], s.w.admin);
    expect(await s.w.h.fail([await s.claim(c.address, rec(3))], s.w.admin)).toContain('HolderCapReached');
    // Revoking one pass frees a place and the identity: the second wallet can now take over.
    await s.w.h.send([await revokePassTerms({ authority: s.w.admin, mint: s.mint, owner: a.address, identity: id32(1) })], s.w.admin);
    expect(s.rulesNow()!.passes).toBe(1);
    await s.w.h.send([await s.claim(a2.address, rec(1), { previousHolder: a.address })], s.w.admin);
    expect((await s.bindingOf(id32(1))).wallet).toBe(a2.address);
    expect(s.rulesNow()!.passes).toBe(2);
    s.w.h.setTime(T0 + 1_000n);
    expect(await s.w.h.fail([await s.claim(c.address, rec(3))], s.w.admin)).toContain('IssuanceClosed');
  });

  it('a denied wallet cannot obtain a pass; an existing pass can be closed by anyone; lifting the denial reopens the door', async () => {
    const s = await setup({ requiredFlags: FLAG.kyc });
    const bad = await s.w.trader();
    const good = await s.w.trader();
    await s.attest(bad.address, rec(1));
    await s.attest(good.address, rec(2));
    await s.w.h.send([await denyWallet({ authority: s.w.admin, mint: s.mint, owner: bad.address, reason: 1 })], s.w.admin);
    expect(await s.w.h.fail([await s.claim(bad.address, rec(1))], s.w.admin)).toContain('WalletDenied');
    // A wallet that already holds a pass and is denied afterwards loses it to anyone who asks.
    await s.w.h.send([await s.claim(good.address, rec(2))], s.w.admin);
    const stranger = await s.w.trader();
    expect(await s.w.h.fail([await revokeDenied({ mint: s.mint, owner: good.address, identity: id32(2) })], stranger)).toContain('NotDenied');
    await s.w.h.send([await denyWallet({ authority: s.w.admin, mint: s.mint, owner: good.address, reason: 2 })], s.w.admin);
    await s.w.h.send([await revokeDenied({ mint: s.mint, owner: good.address, identity: id32(2) })], stranger);
    expect(s.w.h.exists(await s.passAddress(good.address))).toBe(false);
    expect(s.rulesNow()!.passes).toBe(0);
    // Only the authority lifts a denial.
    expect(await s.w.h.fail([await allowWallet({ authority: stranger, mint: s.mint, owner: bad.address })], stranger)).toContain('Unauthorized');
    await s.w.h.send([await allowWallet({ authority: s.w.admin, mint: s.mint, owner: bad.address })], s.w.admin);
    await s.w.h.send([await s.claim(bad.address, rec(1))], s.w.admin);
  });

  it('blockWallet cuts a pass holder off in one transaction, and only denies a wallet that holds no pass', async () => {
    const s = await setup({ requiredFlags: FLAG.kyc });
    const holder = await s.w.trader();
    const bystander = await s.w.trader();
    await s.attest(holder.address, rec(1));
    await s.w.h.send([await s.claim(holder.address, rec(1))], s.w.admin);
    expect(s.rulesNow()!.passes).toBe(1);
    // Not the authority: nothing happens.
    const stranger = await s.w.trader();
    expect(await s.w.h.fail(await blockWallet({ authority: stranger, mint: s.mint, owner: holder.address, reason: 1, holdsPass: true, identity: id32(1) }), stranger)).toContain('Unauthorized');
    await s.w.h.send(await blockWallet({ authority: s.w.admin, mint: s.mint, owner: holder.address, reason: 1, holdsPass: true, identity: id32(1) }), s.w.admin);
    expect(s.w.h.exists(await s.passAddress(holder.address))).toBe(false);
    expect(s.w.h.exists((await findIdentityAddress(s.mint, id32(1)))[0])).toBe(false);
    expect(s.rulesNow()!.passes).toBe(0);
    // The block holds: the attestation is still live, and the wallet still cannot get a pass.
    expect(await s.w.h.fail([await s.claim(holder.address, rec(1))], s.w.admin)).toContain('WalletDenied');
    // A wallet with no pass is only denied.
    await s.w.h.send(await blockWallet({ authority: s.w.admin, mint: s.mint, owner: bystander.address, reason: 2, holdsPass: false }), s.w.admin);
    await s.attest(bystander.address, rec(2));
    expect(await s.w.h.fail([await s.claim(bystander.address, rec(2))], s.w.admin)).toContain('WalletDenied');
  });

  it('passes end by expiry or by the attestation being closed, by anyone, and not before', async () => {
    const s = await setup({});
    await s.w.h.send([await s.activate({})], s.w.admin);
    const a = await s.w.trader();
    const b = await s.w.trader();
    const attA = await s.attest(a.address, rec(1), T0 + 1_000n);
    const attB = await s.attest(b.address, rec(2), 0n);
    await s.w.h.send([await s.claim(a.address, rec(1))], s.w.admin);
    await s.w.h.send([await s.claim(b.address, rec(2))], s.w.admin);
    const stranger = await s.w.trader();
    const revoke = (o: Address, n: number) => revokeExpired({ mint: s.mint, owner: o, identity: id32(n), identitySas: s.identitySas });
    expect(await s.w.h.fail([await revoke(a.address, 1)], stranger)).toContain('NotExpired');
    expect(await s.w.h.fail([await revoke(b.address, 2)], stranger)).toContain('NotExpired');
    s.w.h.setTime(T0 + 1_000n);
    await s.w.h.send([await revoke(a.address, 1)], stranger);
    expect(s.w.h.exists(await s.passAddress(a.address))).toBe(false);
    expect(s.w.h.exists((await findTermsAddress(s.mint, a.address))[0])).toBe(false);
    expect(s.w.h.exists((await findIdentityAddress(s.mint, id32(1)))[0])).toBe(false);
    // The attester closes b's attestation (a lapsed KYC): the pass can then be revoked by anyone.
    await s.closeAttestation(attB);
    await s.w.h.send([await revoke(b.address, 2)], stranger);
    expect(s.w.h.exists(await s.passAddress(b.address))).toBe(false);
    expect(s.rulesNow()!.passes).toBe(0);
    void attA;
  });

  it('tightening the rules lets anyone close the passes that no longer conform, and only those', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN', 'GB'] });
    const a = await s.w.trader();
    const b = await s.w.trader();
    await s.attest(a.address, rec(1, { country: IN }));
    await s.attest(b.address, rec(2, { country: GB }));
    await s.w.h.send([await s.claim(a.address, rec(1, { country: IN }))], s.w.admin);
    await s.w.h.send([await s.claim(b.address, rec(2, { country: GB }))], s.w.admin);
    const stranger = await s.w.trader();
    const close = (o: Address, n: number) => revokeNonconforming({ mint: s.mint, owner: o, identity: id32(n) });
    expect(await s.w.h.fail([await close(a.address, 1)], stranger)).toContain('StillConforms');
    // The issuer drops the UK from the allow list.
    await s.w.h.send([await setRules({ authority: s.w.admin, mint: s.mint, rules: buildRules({ identity: s.identitySas, countryPolicy: 'allow', countries: ['IN'] }) })], s.w.admin);
    await s.w.h.send([await close(b.address, 2)], stranger);
    expect(s.w.h.exists(await s.passAddress(b.address))).toBe(false);
    expect(await s.w.h.fail([await close(a.address, 1)], stranger)).toContain('StillConforms');
    expect(s.w.h.exists(await s.passAddress(a.address))).toBe(true);
    expect(s.rulesNow()!.passes).toBe(1);
  });

  it('refresh_terms re-reads the attestation: a raised cap lands, a changed identity or a failing country does not', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN'] });
    const a = await s.w.trader();
    const att = await s.attest(a.address, rec(1, { cap: 1_000n }));
    await s.w.h.send([await s.claim(a.address, rec(1, { cap: 1_000n }))], s.w.admin);
    expect((await s.termsOf(a.address)).cap).toBe(1_000n);
    await s.closeAttestation(att);
    await s.attest(a.address, rec(1, { cap: 9_000n, tier: Tier.accredited }));
    await s.w.h.send([await refreshTerms({ mint: s.mint, owner: a.address, identitySas: s.identitySas })], s.w.admin);
    const t = await s.termsOf(a.address);
    expect([t.cap, t.tier]).toEqual([9_000n, Tier.accredited]);
    // The identity cannot change under a live pass.
    await s.closeAttestation((await deriveAttestationPda({ credential: s.identitySas.credential, schema: s.identitySas.schema, nonce: a.address }))[0]);
    await s.attest(a.address, rec(2));
    expect(await s.w.h.fail([await refreshTerms({ mint: s.mint, owner: a.address, identitySas: s.identitySas })], s.w.admin)).toContain('IdentityMismatch');
    // A refreshed record that breaks a rule is refused (the old terms stay, and revoke_nonconforming does not apply yet).
    await s.closeAttestation((await deriveAttestationPda({ credential: s.identitySas.credential, schema: s.identitySas.schema, nonce: a.address }))[0]);
    await s.attest(a.address, rec(1, { country: US }));
    expect(await s.w.h.fail([await refreshTerms({ mint: s.mint, owner: a.address, identitySas: s.identitySas })], s.w.admin)).toContain('CountryNotAllowed');
    expect((await s.termsOf(a.address)).country).toBe(IN);
  });

  it('a terms-bearing allowlist: listed wallets claim with their exact terms; changed terms and outsiders are refused', async () => {
    const s = await setup({});
    await s.w.h.send([await s.activate({})], s.w.admin);
    const listed = [await s.w.trader(), await s.w.trader(), await s.w.trader()];
    const terms = listed.map((_, i) => ({ identity: id32(10 + i), country: IN, tier: Tier.retail, flags: FLAG.kyc, cap: BigInt(i) * 1_000n, expiresTs: 0n }));
    const allowlist = buildTermsAllowlist(s.mint, listed.map((l, i) => ({ owner: l.address, terms: terms[i]! })));
    await s.w.h.send([await setRules({ authority: s.w.admin, mint: s.mint, rules: buildRules({ identity: s.identitySas, allowlistRoot: allowlist.root }) })], s.w.admin);
    for (const [i, l] of listed.entries()) {
      await s.w.h.send([await claimPassMerkleTerms({ payer: s.w.admin, owner: l.address, mint: s.mint, terms: terms[i]!, proof: allowlist.proofFor(l.address)! })], s.w.admin);
      expect((await s.termsOf(l.address)).source).toBe(2);
    }
    // Claiming with better terms than the leaf (a bigger cap) breaks the proof.
    const outsider = await s.w.trader();
    expect(await s.w.h.fail([await claimPassMerkleTerms({ payer: s.w.admin, owner: outsider.address, mint: s.mint, terms: terms[0]!, proof: allowlist.proofFor(listed[0]!.address)! })], s.w.admin)).toContain('NotOnAllowlist');
    expect(await s.w.h.fail([await claimPassMerkleTerms({ payer: s.w.admin, owner: outsider.address, mint: s.mint, terms: { ...terms[1]!, cap: 10n ** 12n }, proof: [] })], s.w.admin)).toContain('NotOnAllowlist');
    expect(s.rulesNow()!.passes).toBe(3);
  });

  it('the authority grants a pass with terms under the same rules, and cannot grant what the rules forbid', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN'], requiredFlags: FLAG.kyc });
    const insider = await s.w.trader();
    const terms = { identity: id32(40), country: IN, tier: Tier.qualified, flags: FLAG.kyc | FLAG.affiliate, cap: 0n, expiresTs: 0n };
    const stranger = await s.w.trader();
    expect(await s.w.h.fail([await grantPassTerms({ authority: stranger, mint: s.mint, owner: insider.address, terms })], stranger)).toContain('Unauthorized');
    expect(await s.w.h.fail([await grantPassTerms({ authority: s.w.admin, mint: s.mint, owner: insider.address, terms: { ...terms, country: US } })], s.w.admin)).toContain('CountryNotAllowed');
    await s.w.h.send([await grantPassTerms({ authority: s.w.admin, mint: s.mint, owner: insider.address, terms })], s.w.admin);
    const t = await s.termsOf(insider.address);
    expect([t.source, t.flags & FLAG.affiliate]).toEqual([0, FLAG.affiliate]);
  });

  it('a pass issued before the rules existed can still be revoked by the authority, and the counter follows', async () => {
    const s = await setup({});
    const early = await s.w.trader();
    const [pass] = await findPassAddress(s.mint, early.address);
    await s.w.h.send([getGrantPassInstruction({ authority: s.w.admin, config: s.config, owner: early.address, pass } as never)], s.w.admin);
    // The gate is told how many passes already exist.
    await s.w.h.send([await initRules({ authority: s.w.admin, mint: s.mint, rules: buildRules({ identity: s.identitySas, passes: 1 }) })], s.w.admin);
    expect(s.rulesNow()!.passes).toBe(1);
    await s.w.h.send([await revokePassTerms({ authority: s.w.admin, mint: s.mint, owner: early.address })], s.w.admin);
    expect(s.w.h.exists(pass)).toBe(false);
    expect(s.rulesNow()!.passes).toBe(0);
  });
});

describe.skipIf(!existsSync(SO))('eligibility diagnostics', () => {
  it('names the exact reason a wallet is ineligible, and agrees with the program once it claims', async () => {
    const s = await setup({ countryPolicy: 'allow', countries: ['IN'], minTier: Tier.accredited, requiredFlags: FLAG.kyc, maxPasses: 5 });
    const read: AccountReader = async (addrs) =>
      addrs.map((a) => {
        const acct = s.w.h.svm.getAccount(a);
        return acct.exists ? { data: acct.data, owner: acct.programAddress } : null;
      });
    const now = T0;
    const dx = (wallet: Address) => diagnoseEligibility({ mint: s.mint, wallet, now, read });
    const alice = await s.w.trader();
    expect((await dx(alice.address)).reasons.map((r) => r.code)).toEqual(['NO_ATTESTATION']);
    await s.attest(alice.address, rec(1, { country: US, tier: Tier.retail, flags: 0 }));
    expect((await dx(alice.address)).reasons.map((r) => r.code).sort()).toEqual(['COUNTRY_NOT_ALLOWED', 'MISSING_FLAGS', 'TIER_TOO_LOW']);
    const bob = await s.w.trader();
    await s.attest(bob.address, rec(2, { tier: Tier.accredited }));
    const d = await dx(bob.address);
    expect(d.reasons).toEqual([]);
    expect(d.canClaim).toBe(true);
    expect(d.eligible).toBe(false);
    await s.w.h.send([await s.claim(bob.address, rec(2, { tier: Tier.accredited }))], s.w.admin);
    expect(await dx(bob.address)).toMatchObject({ eligible: true, hasPass: true, reasons: [] });
    // The same identity on a second wallet is explained, not just refused.
    const bob2 = await s.w.trader();
    await s.attest(bob2.address, rec(2, { tier: Tier.accredited }));
    expect((await dx(bob2.address)).reasons.map((r) => r.code)).toEqual(['IDENTITY_HELD_BY_OTHER_WALLET']);
    // When the first pass ends its identity binding ends with it, so the second wallet can take the identity over with nothing to name.
    await s.w.h.send([await revokePassTerms({ authority: s.w.admin, mint: s.mint, owner: bob.address, identity: id32(2) })], s.w.admin);
    const taken = await dx(bob2.address);
    expect(taken).toMatchObject({ canClaim: true, previousHolder: null, reasons: [] });
    await s.w.h.send([await s.claim(bob2.address, rec(2, { tier: Tier.accredited }))], s.w.admin);
    expect(await dx(bob2.address)).toMatchObject({ eligible: true, hasPass: true });
    // A denied wallet.
    await s.w.h.send([await denyWallet({ authority: s.w.admin, mint: s.mint, owner: alice.address, reason: 1 })], s.w.admin);
    expect((await dx(alice.address)).reasons.map((r) => r.code)).toContain('DENIED');
    // An expired attestation.
    const carol = await s.w.trader();
    await s.attest(carol.address, rec(3, { tier: Tier.accredited }), T0 + 5n);
    const late = await diagnoseEligibility({ mint: s.mint, wallet: carol.address, now: T0 + 5n, read });
    expect(late.reasons.map((r) => r.code)).toEqual(['ATTESTATION_EXPIRED']);
  });
});

describe('the CROSS_CORE constant', () => {
  it('equals the cross_core program address the clients use', async () => {
    const { CROSS_CORE_PROGRAM_ADDRESS } = await import('../../../cross-core-client/src/index.js');
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(fileURLToPath(new URL('../../../../programs/cross_gate/src/lib.rs', import.meta.url)), 'utf8');
    const m = /CROSS_CORE_PROGRAM_ID: Pubkey = pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(src);
    expect(m?.[1]).toBe(CROSS_CORE_PROGRAM_ADDRESS);
  });
});
