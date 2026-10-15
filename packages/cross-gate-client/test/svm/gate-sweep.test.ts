// The keeper's gate sweep (services/keeper/src/gate-sweep.ts) against the real `cross_gate` program and the mainnet SAS binary on LiteSVM: the instructions the sweep builds
// are the ones the program accepts, each pass is closed for the reason the sweep named and not before, a pass that is in order is left alone, and a second sweep has nothing to do.
//
// `getProgramAccounts` does not exist on LiteSVM, so the sweep's `program` dependency answers from the addresses this test knows (the gate's config and the wallets' terms
// accounts); what the sweep does with them, and what the program does with its instructions, is the real thing.
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
  FLAG,
  IDENTITY_SCHEMA,
  Mode,
  Tier,
  buildRules,
  claimPassAttested,
  countryNumeric,
  denyWallet,
  findConfigPda,
  findIdentityAddress,
  findPassAddress,
  findTermsAddress,
  getCreateConfigInstruction,
  initRules,
  packIdentityData,
  readRules,
  setRules,
  type IdentityRecord,
} from '../../src/index.js';
import { CONFIG_WITH_RULES_SIZE, TERMS_ACCOUNT_SIZE, runGateSweep } from '../../../../services/keeper/src/gate-sweep.js';
import { World } from '../../../../tests/core/src/world.js';
import { T0 } from '../../../../tests/core/src/harness.js';

const SAS = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
const SO = fileURLToPath(new URL('../../../../tests/fixtures/solana_attestation_service.so', import.meta.url));
const ix = (x: unknown) => x as Instruction; // sas-lib targets kit 5; instructions are plain data
const IN = countryNumeric('IN')!;
const GB = countryNumeric('GB')!;
const id32 = (n: number) => new Uint8Array(32).fill(n);
const rec = (n: number, o: Partial<IdentityRecord> = {}): IdentityRecord => ({ identity: id32(n), country: IN, tier: Tier.retail, flags: FLAG.kyc | FLAG.sanctionsClear, cap: 0n, ...o });

describe.skipIf(!existsSync(SO))('the keeper’s gate sweep against cross_gate', () => {
  it('closes expired, attestation-gone, denied and nonconforming passes for their reasons, leaves the rest, and a second sweep finds nothing', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(SAS, SO);
    const attester = await w.h.wallet();
    const [credential] = await deriveCredentialPda({ authority: attester.address, name: 'oc-attester' });
    const [schema] = await deriveSchemaPda({ credential, name: IDENTITY_SCHEMA.name, version: IDENTITY_SCHEMA.version });
    await w.h.send([ix(getCreateCredentialInstruction({ payer: attester, credential, authority: attester, name: 'oc-attester', signers: [attester.address] } as never))], attester);
    await w.h.send([ix(getCreateSchemaInstruction({ payer: attester, authority: attester, credential, schema, name: IDENTITY_SCHEMA.name, description: IDENTITY_SCHEMA.description, layout: IDENTITY_SCHEMA.layout, fieldNames: [...IDENTITY_SCHEMA.fieldNames] } as never))], attester);
    const identitySas = { credential, schema };

    type Held = { exists: boolean; data: Uint8Array; lamports: bigint; programAddress: Address };
    const held = (a: Address): Held | null => {
      const x = w.h.svm.getAccount(a) as unknown as Held;
      return x.exists ? x : null;
    };
    const mint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    const rules = (over: Parameters<typeof buildRules>[0] = {}) => buildRules({ identity: identitySas, countryPolicy: 'allow', countries: ['IN', 'GB'], minTier: Tier.retail, requiredFlags: FLAG.kyc, ...over });
    await w.h.send([await initRules({ authority: w.admin, mint, rules: rules() })], w.admin);

    const attest = async (subject: Address, r: IdentityRecord, expiry = 0n) => {
      const [attestation] = await deriveAttestationPda({ credential, schema, nonce: subject });
      await w.h.send([ix(getCreateAttestationInstruction({ payer: attester, authority: attester, credential, schema, attestation, nonce: subject, data: packIdentityData(r), expiry } as never))], attester);
      return attestation;
    };
    const claim = (owner: Address, r: IdentityRecord) => claimPassAttested({ payer: w.admin, owner, mint, identity: r.identity, identitySas });

    const people = { fine: await w.h.wallet(), lapsing: await w.h.wallet(), gone: await w.h.wallet(), denied: await w.h.wallet(), british: await w.h.wallet() };
    const records = { fine: rec(1), lapsing: rec(2), gone: rec(3), denied: rec(4), british: rec(5, { country: GB }) };
    await attest(people.fine.address, records.fine);
    await attest(people.lapsing.address, records.lapsing, T0 + 1_000n);
    const goneAttestation = await attest(people.gone.address, records.gone);
    await attest(people.denied.address, records.denied);
    await attest(people.british.address, records.british);
    for (const k of Object.keys(people) as (keyof typeof people)[]) await w.h.send([await claim(people[k].address, records[k])], w.admin);
    expect(readRules(held(config)!.data)!.passes).toBe(5);

    // What happens to the passes after they were issued: one lapses with its attestation's expiry, one attestation is closed by the attester, one wallet is denied, the issuer
    // drops the United Kingdom from its allow list.
    w.h.setTime(T0 + 1_000n);
    await w.h.send([ix(getCloseAttestationInstruction({ payer: attester, authority: attester, credential, attestation: goneAttestation } as never))], attester);
    await w.h.send([await denyWallet({ authority: w.admin, mint, owner: people.denied.address, reason: 1 })], w.admin);
    await w.h.send([await setRules({ authority: w.admin, mint, rules: rules({ countries: ['IN'] }) })], w.admin);

    const keeper = await w.h.wallet();
    const owners = Object.values(people).map((p) => p.address);
    const balanceBefore = new Map(owners.map((o) => [o, held(o)!.lamports]));
    const termsAddresses = await Promise.all(owners.map(async (o) => (await findTermsAddress(mint, o))[0]));
    const deps = (dryRun = false) => ({
      dryRun,
      now: async () => BigInt(w.h.svm.getClock().unixTimestamp),
      program: async (size: number) => {
        const known = size === CONFIG_WITH_RULES_SIZE ? [config] : size === TERMS_ACCOUNT_SIZE ? termsAddresses : [];
        return known.flatMap((a) => {
          const acct = held(a);
          return acct && acct.data.length === size ? [{ address: a, data: acct.data }] : [];
        });
      },
      fetch: async (a: Address) => {
        const acct = held(a);
        return acct && acct.data.length > 0 ? { data: acct.data, owner: acct.programAddress } : null;
      },
      send: async (ixs: Instruction[]) => {
        await w.h.send(ixs, keeper);
        return 'ok';
      },
    });

    // A dry run names the four and changes nothing.
    const dry = await runGateSweep(deps(true));
    expect(dry.checked).toBe(5);
    expect(dry.wouldClose).toHaveLength(4);
    for (const o of owners) expect(w.h.exists((await findPassAddress(mint, o))[0])).toBe(true);

    const first = await runGateSweep(deps());
    expect(first.failed).toEqual([]);
    expect(Object.fromEntries(first.closed.map((c) => [c.owner, c.kind]))).toEqual({
      [people.lapsing.address]: 'expired',
      [people.gone.address]: 'attestation-gone',
      [people.denied.address]: 'denied',
      [people.british.address]: 'nonconforming',
    });
    // The pass that is in order is untouched; every other pass, its terms and its identity binding are gone, and the live-pass counter says one.
    expect(w.h.exists((await findPassAddress(mint, people.fine.address))[0])).toBe(true);
    expect(w.h.exists((await findIdentityAddress(mint, records.fine.identity))[0])).toBe(true);
    for (const k of ['lapsing', 'gone', 'denied', 'british'] as const) {
      expect(w.h.exists((await findPassAddress(mint, people[k].address))[0]), k).toBe(false);
      expect(w.h.exists((await findTermsAddress(mint, people[k].address))[0]), k).toBe(false);
      expect(w.h.exists((await findIdentityAddress(mint, records[k].identity))[0]), k).toBe(false);
      // The rent went back to the pass owner, and the keeper paid only the fee.
      expect(held(people[k].address)!.lamports > balanceBefore.get(people[k].address)!, k).toBe(true);
    }
    expect(readRules(held(config)!.data)!.passes).toBe(1);

    const second = await runGateSweep(deps());
    expect(second.checked).toBe(1);
    expect(second.closed).toEqual([]);
    expect(second.failed).toEqual([]);
  });
});
